import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelRequestOutcome } from "@oh-my-pi/pi-utils/model-request-data";
import {
	retainModelRequestWriterCredential,
	withVerifiedModelRequestJournalBinding,
	type ModelRequestJournalLeaseBinding,
} from "@oh-my-pi/pi-utils/model-request-journal-authority";
import {
	assertJournalExecutionReady,
	closeJournalSession,
	composeJournalSession,
	openFileJournalCell,
	type ModelRequestExecution,
} from "@oh-my-pi/pi-utils/model-request-journal-composition";
import { withRawModelRequestJournalLeases } from "@oh-my-pi/pi-utils/model-request-journal-leases";
import { openModelRequestJournalDatabase } from "@oh-my-pi/pi-utils/model-request-journal-sqlite-control";
import {
	registerModelRequestGate,
	type ModelRequestDecision,
	type ModelRequestLease,
} from "../../src/model-request-gate";
import { getModelRequestRuntime } from "../../src/model-request-runtime";
import { gatedSend } from "../../src/utils/model-request-fetch";
import { modelRequestBuiltinFetch } from "../../src/utils/model-request-builtin-fetch";
import {
	helloContext,
	loopbackModel,
	scripted,
	startLoopbackProvider,
	textReplyFor,
} from "../helpers/model-request-loopback";

const runtime = getModelRequestRuntime();
const scenario = process.argv[2];
const scenarios = [
	"gate-late-allow-settle-pending",
	"gate-late-allow-settle-reject",
	"gate-abort-late-allow",
	"pass-body-hold-until-read",
	"pass-body-cancel-reject",
	"dispatch-sync-throw-joins-response",
	"guarded-settle-reentry",
	"guarded-transfer-cleanup-on-settle-reject",
] as const;
if (!scenarios.some(value => value === scenario)) throw new Error(`unknown outer lifetime scenario: ${scenario}`);

async function withReady(
	use: (ctx: { close: () => Promise<void> }) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
	const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ai-outer-lifetime-")));
	const cell = openFileJournalCell({ cwd: directory, sessionDir: path.join(directory, "sessions") });
	const rootSessionId = cell.getSessionId();
	const agent = Object.freeze({ id: `main-${randomUUID()}`, name: "main", kind: "main" as const, depth: 0 });
	const storeId = `test-${randomUUID()}`;
	const databasePath = path.join(directory, "state.sqlite3");
	fs.writeFileSync(databasePath, "", { mode: 0o600 });
	const database = openModelRequestJournalDatabase(databasePath, { strict: true, safeIntegers: false });
	const writerId = `writer-${randomUUID()}`;
	const epochWriterId = `writer-${randomUUID()}`;
	const requester = Object.freeze({ writerId });
	const token = randomBytes(32);
	const physicalBindingId = randomUUID();
	retainModelRequestWriterCredential(requester, {
		writerId,
		token,
		role: "harness-core",
		capabilities: [],
		identity: { sessionId: rootSessionId, id: agent.id, kind: agent.kind, depth: agent.depth },
	});
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
			"INSERT INTO writer(id,tx_seq,created_at_ms,role,capabilities_json,token_hash) VALUES(?,1,1,'operator-command','[]',?)",
		)
		.run(epochWriterId, createHash("sha256").update(randomBytes(32)).digest("hex"));
	database
		.query(
			"INSERT INTO writer(id,tx_seq,created_at_ms,role,capabilities_json,agent_kind,omp_agent_id,depth,omp_session_id,token_hash) VALUES(?,3,3,'harness-core','[]','main',?,0,?,?)",
		)
		.run(writerId, agent.id, rootSessionId, createHash("sha256").update(token).digest("hex"));
	database
		.query(
			"INSERT INTO store_config_event(id,tx_seq,created_at_ms,key,value_json,approval_id,writer_id) VALUES('epoch-1',2,2,'budget_authority_epoch',?,NULL,?)",
		)
		.run(JSON.stringify({ schemaVersion: 1, authorityEpoch: 1, physicalBindingId }), epochWriterId);
	await withRawModelRequestJournalLeases({ storeId, control: "exclusive", maintenance: "exclusive" }, async raw => {
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
	});
	return withVerifiedModelRequestJournalBinding(
		{ resources: { storeId, databasePath }, requester, mode: "resume", rootSessionId },
		async binding => {
			const execution = runtime.createSessionExecution({
				sessionId: () => rootSessionId,
				root: { kind: "self", modelRequestJournalLeaseBinding: binding },
				agent,
				purpose: "main",
			});
			return runtime.runWith(execution, async () => {
				const session = await composeJournalSession({ cell, root: cell, binding, execution });
				assertJournalExecutionReady(execution);
				let closing: Promise<void> | undefined;
				const close = () => (closing ??= closeJournalSession(session));
				const payload = await use({ close });
				await close();
				return payload;
			});
		},
	);
}

function recordingLease(): {
	lease: ModelRequestLease;
	settled: ModelRequestOutcome[];
	firstSettle: Promise<ModelRequestOutcome>;
} {
	const settled: ModelRequestOutcome[] = [];
	const first = Promise.withResolvers<ModelRequestOutcome>();
	const lease: ModelRequestLease = {
		beginSend() {},
		observeResponse() {},
		observeChunk() {},
		async settle(outcome) {
			settled.push(outcome);
			first.resolve(outcome);
		},
	};
	return { lease, settled, firstSettle: first.promise };
}

async function expectRejects(promise: Promise<unknown>): Promise<void> {
	try {
		await promise;
		throw new Error("expected rejection");
	} catch {
		// expected
	}
}

async function runScenario(): Promise<Record<string, unknown>> {
	switch (scenario) {
		case "gate-late-allow-settle-pending": {
			const decision = Promise.withResolvers<ModelRequestDecision>();
			const { lease, settled, firstSettle } = recordingLease();
			const lateSettle = Promise.withResolvers<void>();
			lease.settle = async outcome => {
				settled.push(outcome);
				await lateSettle.promise;
				firstSettle.resolve(outcome);
			};
			registerModelRequestGate("outer-lifetime", { authorize: () => decision.promise }, 1);
			const model = loopbackModel("openai-completions", "http://127.0.0.1:9");
			return withReady(async ({ close }) => {
				const authorize = runtime.authorize({
					requestId: randomUUID(),
					reason: "user",
					kind: "chat",
					model,
					wire: undefined,
				});
				await Bun.sleep(5);
				decision.resolve({ type: "allow", lease });
				await expectRejects(authorize);
				const late = await Promise.race([
					firstSettle.then(() => "settled" as const),
					new Promise<"pending">(resolve => setTimeout(() => resolve("pending"), 50)),
				]);
				lateSettle.resolve();
				await firstSettle;
				await close();
				return { late, settledCount: settled.length };
			});
		}
		case "gate-late-allow-settle-reject": {
			const decision = Promise.withResolvers<ModelRequestDecision>();
			const { lease, settled } = recordingLease();
			const reject = new Error("late unused lease settle failed");
			lease.settle = async () => {
				throw reject;
			};
			registerModelRequestGate("outer-lifetime", { authorize: () => decision.promise }, 1);
			const model = loopbackModel("openai-completions", "http://127.0.0.1:9");
			return withReady(async ({ close }) => {
				const authorize = runtime.authorize({
					requestId: randomUUID(),
					reason: "user",
					kind: "chat",
					model,
					wire: undefined,
				});
				await Bun.sleep(5);
				decision.resolve({ type: "allow", lease });
				await expectRejects(authorize);
				await Bun.sleep(30);
				await close();
				return { settledCount: settled.length, rejectMessage: reject.message };
			});
		}
		case "gate-abort-late-allow": {
			const decision = Promise.withResolvers<ModelRequestDecision>();
			const { lease, settled } = recordingLease();
			registerModelRequestGate("outer-lifetime", { authorize: () => decision.promise }, 5_000);
			const controller = new AbortController();
			const model = loopbackModel("openai-completions", "http://127.0.0.1:9");
			return withReady(async ({ close }) => {
				const authorize = runtime.authorize({
					requestId: randomUUID(),
					reason: "user",
					kind: "chat",
					model,
					wire: undefined,
					signal: controller.signal,
				});
				controller.abort(new Error("abort-before-gate"));
				decision.resolve({ type: "allow", lease });
				await expectRejects(authorize);
				await Bun.sleep(30);
				await close();
				return { settled: settled[0] };
			});
		}
		case "pass-body-hold-until-read": {
			registerModelRequestGate("outer-lifetime", { authorize: () => ({ type: "pass" }) }, undefined);
			const hold = Promise.withResolvers<void>();
			const loopback = await startLoopbackProvider(
				scripted({ status: 200, chunks: ["hello"], holdUntil: hold.promise }),
			);
			const model = loopbackModel("openai-completions", loopback.origin);
			return withReady(async ({ close }) => {
				const closeRace = close();
				const response = await gatedSend({
					model,
					kind: "chat",
					input: `${loopback.origin}/v1/chat/completions`,
					init: { method: "POST", body: JSON.stringify(helloContext()) },
					transport: modelRequestBuiltinFetch,
					send: () =>
						modelRequestBuiltinFetch(`${loopback.origin}/v1/chat/completions`, {
							method: "POST",
							body: JSON.stringify(helloContext()),
						}),
				});
				const blocked = await Promise.race([
					closeRace.then(() => "closed" as const),
					new Promise<"pending">(resolve => setTimeout(() => resolve("pending"), 80)),
				]);
				hold.resolve();
				await response.text();
				await closeRace;
				loopback.stop();
				return { blockedBeforeRead: blocked };
			});
		}
		case "pass-body-cancel-reject": {
			registerModelRequestGate("outer-lifetime", { authorize: () => ({ type: "pass" }) }, undefined);
			const loopback = await startLoopbackProvider(scripted(textReplyFor("abc")));
			const model = loopbackModel("openai-completions", loopback.origin);
			return withReady(async ({ close }) => {
				const response = await gatedSend({
					model,
					kind: "chat",
					input: `${loopback.origin}/v1/chat/completions`,
					init: { method: "POST", body: JSON.stringify(helloContext()) },
					transport: modelRequestBuiltinFetch,
					send: () =>
						modelRequestBuiltinFetch(`${loopback.origin}/v1/chat/completions`, {
							method: "POST",
							body: JSON.stringify(helloContext()),
						}),
				});
				await response.body?.cancel();
				await Bun.sleep(30);
				await close();
				loopback.stop();
				return { cancelled: true };
			});
		}
		case "dispatch-sync-throw-joins-response": {
			registerModelRequestGate("outer-lifetime", { authorize: () => ({ type: "pass" }) }, undefined);
			const loopback = await startLoopbackProvider(scripted(textReplyFor("ok")));
			const model = loopbackModel("openai-completions", loopback.origin);
			return withReady(async ({ close }) => {
				let observed = 0;
				const original = modelRequestBuiltinFetch;
				const throwingFetch: typeof modelRequestBuiltinFetch = async (input, init) => {
					observed++;
					await original(input, init);
					throw new Error("sync throw after dispatch started");
				};
				let failure: unknown;
				try {
					await gatedSend({
						model,
						kind: "chat",
						input: `${loopback.origin}/v1/chat/completions`,
						init: { method: "POST", body: JSON.stringify(helloContext()) },
						transport: throwingFetch,
						send: () =>
							throwingFetch(`${loopback.origin}/v1/chat/completions`, {
								method: "POST",
								body: JSON.stringify(helloContext()),
							}),
					});
				} catch (error) {
					failure = error;
				}
				await close();
				loopback.stop();
				return {
					observed,
					failure: failure instanceof Error ? failure.message : String(failure),
				};
			});
		}
		case "guarded-settle-reentry": {
			const { lease, settled } = recordingLease();
			registerModelRequestGate("outer-lifetime", { authorize: async () => ({ type: "allow", lease }) }, undefined);
			const model = loopbackModel("openai-completions", "http://127.0.0.1:9");
			return withReady(async ({ close }) => {
				const permit = await runtime.authorize({
					requestId: randomUUID(),
					reason: "user",
					kind: "chat",
					model,
					wire: undefined,
				});
				const guarded = permit.lease;
				if (!guarded) throw new Error("expected lease");
				guarded.beginSend();
				await Promise.all([
					guarded.settle({ type: "response-ended", status: 200 }),
					guarded.settle({ type: "not-sent", aborted: true }),
				]);
				await close();
				return { settled };
			});
		}
		case "guarded-transfer-cleanup-on-settle-reject": {
			const reject = new Error("guarded settle failed");
			const lease: ModelRequestLease = {
				beginSend() {},
				observeResponse() {},
				observeChunk() {},
				settle: async () => {
					throw reject;
				},
			};
			registerModelRequestGate("outer-lifetime", { authorize: async () => ({ type: "allow", lease }) }, undefined);
			const model = loopbackModel("openai-completions", "http://127.0.0.1:9");
			return withReady(async ({ close }) => {
				const permit = await runtime.authorize({
					requestId: randomUUID(),
					reason: "user",
					kind: "chat",
					model,
					wire: undefined,
				});
				const guarded = permit.lease;
				if (!guarded) throw new Error("expected lease");
				guarded.beginSend();
				let failure: unknown;
				try {
					await guarded.settle({ type: "not-sent", aborted: false });
				} catch (error) {
					failure = error;
				}
				await close();
				return { failure: failure === reject };
			});
		}
		default:
			throw new Error("unhandled scenario");
	}
}

void runScenario()
	.then(result => {
		console.log(JSON.stringify(result));
		process.exit(0);
	})
	.catch(error => {
		console.error(error);
		process.exit(1);
	});
