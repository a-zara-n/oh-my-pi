import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildCompactionV2Request,
	requestCompactionV2Streaming,
	requestOpenAiRemoteCompaction,
	requestRemoteCompaction,
} from "@oh-my-pi/pi-agent-core/compaction/openai";
import { getModelRequestRuntime } from "@oh-my-pi/pi-ai/model-request-runtime";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ChainJudge } from "@oh-my-pi/pi-coding-agent/judgment";
import {
	retainModelRequestWriterCredential,
	retireModelRequestWriterCredential,
	withVerifiedModelRequestJournalBinding,
} from "@oh-my-pi/pi-utils/model-request-journal-authority";
import { withRawModelRequestJournalLeases } from "@oh-my-pi/pi-utils/model-request-journal-leases";
import { openModelRequestJournalDatabase } from "@oh-my-pi/pi-utils/model-request-journal-sqlite-control";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

interface CallerResult {
	caller: string;
	getterCalls: number;
	completed: boolean;
	error: string | undefined;
	callbackReached: boolean;
	constructionOnly: boolean;
}

interface ProbeResult {
	journalState: "required-pending";
	results: CallerResult[];
}

async function probe(): Promise<ProbeResult> {
	const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "d37-core-caller-getter-")));
	let namespace: string | undefined;
	try {
		const storeId = `test-${randomUUID()}`;
		const databasePath = path.join(directory, "state.sqlite3");
		fs.writeFileSync(databasePath, "", { mode: 0o600 });
		const database = openModelRequestJournalDatabase(databasePath, { strict: true, safeIntegers: false });
		try {
			fs.chmodSync(databasePath, 0o600);
			const writerId = `writer-${randomUUID()}`;
			const epochWriterId = `writer-${randomUUID()}`;
			const requester = Object.freeze({ writerId });
			const token = randomBytes(32);
			const physicalBindingId = randomUUID();
			retainModelRequestWriterCredential(requester, {
				writerId,
				token,
				role: "operator-command",
				capabilities: [],
			});
			try {
				// The fixed verifier authenticates this actual database, writer credential and authority epoch.
				const common =
					"seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,tx_seq INTEGER NOT NULL,created_at_ms INTEGER NOT NULL";
				database.exec(`PRAGMA journal_mode=WAL; PRAGMA application_id=1330856277; PRAGMA user_version=20;
CREATE TABLE store_meta(singleton INTEGER PRIMARY KEY,store_id TEXT) STRICT;
CREATE TABLE tx_log(tx_seq INTEGER PRIMARY KEY,writer_id TEXT,op_name TEXT,sealed INTEGER) STRICT;
CREATE TABLE writer(${common},role TEXT NOT NULL,capabilities_json TEXT NOT NULL,agent_kind TEXT,omp_agent_id TEXT,depth INTEGER,parent_writer_id TEXT,omp_session_id TEXT,token_hash TEXT NOT NULL,host_pid INTEGER,component_version_id TEXT) STRICT;
CREATE TABLE writer_event(${common},writer_id TEXT NOT NULL,event TEXT NOT NULL,reason TEXT) STRICT;
CREATE TABLE store_config_event(${common},key TEXT NOT NULL,value_json TEXT NOT NULL,approval_id TEXT,writer_id TEXT NOT NULL) STRICT;`);
				database.query("INSERT INTO store_meta VALUES(1,?)").run(storeId);
				database
					.query(
						"INSERT INTO tx_log VALUES(1,?,'store.init',1),(2,?,'bootstrapModelRequestJournalAuthority',1),(3,?,'registerWriter',1)",
					)
					.run(epochWriterId, epochWriterId, epochWriterId);
				database
					.query(
						"INSERT INTO writer(id,tx_seq,created_at_ms,role,capabilities_json,token_hash) VALUES(?,1,1,'operator-command','[]',?),(?,3,3,'operator-command','[]',?)",
					)
					.run(
						epochWriterId,
						createHash("sha256").update(randomBytes(32)).digest("hex"),
						writerId,
						createHash("sha256").update(token).digest("hex"),
					);
				database
					.query(
						"INSERT INTO store_config_event(id,tx_seq,created_at_ms,key,value_json,approval_id,writer_id) VALUES('epoch-1',2,2,'budget_authority_epoch',?,NULL,?)",
					)
					.run(JSON.stringify({ schemaVersion: 1, authorityEpoch: 1, physicalBindingId }), epochWriterId);
				await withRawModelRequestJournalLeases(
					{ storeId, control: "exclusive", maintenance: "exclusive" },
					async raw => {
						namespace = raw.namespacePath;
						const stat = fs.statSync(databasePath);
						fs.writeFileSync(
							raw.recordPath,
							JSON.stringify({
								schemaVersion: 1,
								storeId,
								authorityEpoch: 1,
								physicalBindingId,
								dbDevice: stat.dev,
								dbInode: stat.ino,
								state: "active",
							}),
							{ mode: 0o600 },
						);
					},
				);

				const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
				if (descriptor === undefined || typeof descriptor.value !== "function") {
					throw new Error("Initial builtin fetch descriptor missing");
				}
				const builtin: typeof fetch = descriptor.value;
				const model = getBundledModel("openai", "gpt-5");
				const nativeModel = getBundledModel("typesafe", "jev-latest");
				if (model === undefined || nativeModel === undefined) {
					throw new Error("Probe requires bundled openai/gpt-5 and typesafe/jev-latest");
				}
				const input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }];
				const v2Model = {
					...model,
					remoteCompaction: { ...model.remoteCompaction, enabled: true, v2StreamingEnabled: true },
				};
				const v2Request = buildCompactionV2Request(v2Model, input, "instructions");
				const settings = Settings.isolated({
					modelRoles: { judge: "typesafe/jev-latest" },
					"retry.fallbackChains": { judge: [] },
				});
				const authStorage = createInMemoryAuthStorage();
				try {
					authStorage.keys.setRuntime("typesafe", "probe-key");
					// Finish real registry/model resolution before installing the observed accessor. No refresh or provider I/O.
					const registry = new ModelRegistry(authStorage, path.join(directory, "models.yml"), {
						settings,
						ignoreLocalModelConfig: true,
						cacheDbPath: path.join(directory, "models-cache.db"),
						fetch: builtin,
					});
					const judge = new ChainJudge({ settings, registry, purpose: "test" });
					const primary = judge.primaryModel();
					if (
						primary?.id !== nativeModel.id ||
						primary.provider !== nativeModel.provider ||
						primary.api !== nativeModel.api
					) {
						throw new Error("Real registry did not resolve bundled native judge");
					}
					return await withVerifiedModelRequestJournalBinding<ProbeResult>(
						{
							resources: { storeId, databasePath },
							requester,
							mode: "resume",
							rootSessionId: "d37-core-caller-getter-root",
						},
						async binding => {
							const runtime = getModelRequestRuntime();
							const execution = runtime.createSessionExecution({
								sessionId: () => "d37-core-caller-getter-root",
								root: { kind: "self", modelRequestJournalLeaseBinding: binding },
								agent: { id: "d37-core-caller-getter-agent", name: "main", kind: "main", depth: 0 },
								purpose: "main",
							});
							if (execution.journalState !== "required-pending") {
								throw new Error("Probe requires genuine required-pending execution");
							}
							let callbackReached = false;
							const callers: Array<{ name: string; constructionOnly: boolean; run: () => Promise<unknown> }> = [
								{
									name: "compaction-v2-streaming",
									constructionOnly: false,
									run: () => requestCompactionV2Streaming(v2Model, "probe-key", v2Request),
								},
								{
									name: "openai-remote-compaction",
									constructionOnly: false,
									run: () => requestOpenAiRemoteCompaction(model, "probe-key", input, "instructions"),
								},
								{
									name: "generic-remote-compaction",
									constructionOnly: false,
									run: () =>
										requestRemoteCompaction(
											"http://127.0.0.1:9/summarize",
											{ systemPrompt: "summarize", prompt: "<conversation>hello</conversation>" },
											undefined,
											{ model },
										),
								},
								{
									name: "native-judge",
									constructionOnly: true,
									// Only construct the actual native candidate; never call its judge() or the provider.
									run: () =>
										judge.withCandidate(async (_candidate, kind) => {
											callbackReached = true;
											return kind;
										}),
								},
							];
							const results: CallerResult[] = [];
							for (const caller of callers) {
								let getterCalls = 0;
								let error: string | undefined;
								let completed = false;
								Object.defineProperty(globalThis, "fetch", {
									configurable: true,
									get() {
										getterCalls++;
										return builtin;
									},
								});
								try {
									await runtime.runWith(execution, async () => {
										try {
											await caller.run();
											completed = true;
										} catch (caught) {
											error = caught instanceof Error ? caught.message : String(caught);
										}
									});
								} finally {
									Object.defineProperty(globalThis, "fetch", descriptor);
								}
								results.push({
									caller: caller.name,
									getterCalls,
									completed,
									error,
									callbackReached: caller.name === "native-judge" && callbackReached,
									constructionOnly: caller.constructionOnly,
								});
							}
							if (execution.journalState !== "required-pending") {
								throw new Error("Probe execution left required-pending state");
							}
							return { journalState: execution.journalState, results };
						},
					);
				} finally {
					authStorage.close();
				}
			} finally {
				retireModelRequestWriterCredential(requester);
			}
		} finally {
			database.close();
		}
	} finally {
		try {
			fs.rmSync(directory, { recursive: true, force: true });
		} finally {
			if (namespace !== undefined) fs.rmSync(namespace, { recursive: true, force: true });
		}
	}
}

console.log(JSON.stringify(await probe()));
