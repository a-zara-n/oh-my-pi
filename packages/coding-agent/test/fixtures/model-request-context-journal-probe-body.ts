import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import {
	deriveModelRequestExecution,
	resolveModelRequestScope,
	runWithModelRequestExecution,
} from "@oh-my-pi/pi-ai/model-request-execution";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	childModelRequestRootOf,
	createSessionModelRequestExecution,
	type ModelRequestRootAssignment,
	resolveModelRequestRootSource,
} from "@oh-my-pi/pi-coding-agent/session/model-request-context";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { Api, AssistantMessage } from "@oh-my-pi/pi-utils/model-data";
import {
	type ModelRequestJournalLeaseBinding,
	modelRequestJournalAuthorityRuntimeIdentity,
	retainModelRequestWriterCredential,
	retireModelRequestWriterCredential,
	withVerifiedModelRequestJournalBinding,
} from "@oh-my-pi/pi-utils/model-request-journal-authority";
import {
	assertJournalExecutionIdentity,
	assertJournalExecutionReady,
	composeJournalSession,
	type FileJournalCell,
	openFileJournalCell,
	type ModelRequestExecution,
} from "@oh-my-pi/pi-utils/model-request-journal-composition";
import { withRawModelRequestJournalLeases } from "@oh-my-pi/pi-utils/model-request-journal-leases";
import { openModelRequestJournalDatabase } from "@oh-my-pi/pi-utils/model-request-journal-sqlite-control";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";

// Deliberate invalid-input casts stay at the test boundary; no authority, receipt, or ready setter is installed.
const ROOT_AGENT_ID = "RootAgent";
const agent = { kind: "main", id: ROOT_AGENT_ID, name: "main", depth: 0 } as const;
const unavailable = /Model request journal capability is unavailable/;

function createExecution(candidate?: unknown): ModelRequestExecution {
	return createSessionModelRequestExecution({
		getSessionId: () => "root",
		root: resolveModelRequestRootSource(undefined, candidate as ModelRequestJournalLeaseBinding | undefined),
		agent,
	});
}

function assertPending(execution: ModelRequestExecution): void {
	assertJournalExecutionIdentity(execution);
	assertJournalExecutionIdentity(execution, execution);
	assert.equal(execution.journalState, "required-pending");
	assert.equal(execution.modelRequestScope, undefined);
	assert.throws(() => assertJournalExecutionReady(execution), unavailable);
	assert.throws(() => childModelRequestRootOf(execution), unavailable);
	assert.throws(() => resolveModelRequestScope(execution), unavailable);
}

function assertNotGranted(execution: ModelRequestExecution): void {
	// The refusal boundary may land before the process latch (nothing was
	// granted and nothing needs undoing: fresh executions stay untracked — an
	// ordinary, non-journal execution) or after it (required-pending, where
	// readiness stays refused). Readiness must never appear for the candidate.
	assert(["untracked", "required-pending"].includes(execution.journalState));
	assert.notEqual(execution.journalState, "required-ready");
	if (execution.journalState === "required-pending") {
		assert.throws(() => assertJournalExecutionReady(execution), unavailable);
	}
}

function candidateFor(rootSessionId: string): unknown {
	return Object.freeze({ runtimeIdentity: modelRequestJournalAuthorityRuntimeIdentity, rootSessionId });
}

async function assertSdkRefusesCandidate(foreignRuntime: boolean): Promise<void> {
	const tempDir = TempDir.createSync("@pi-model-request-context-journal-");
	const authStorage = createInMemoryAuthStorage();
	const provider = "model-request-context-journal-probe-provider";
	const api = "model-request-context-journal-probe-api";
	const modelId = "model-request-context-journal-probe-model";
	authStorage.keys.setRuntime(provider, "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
	let publishedSession: AgentSession | undefined;
	let startupFailure: Error | undefined;
	let providerRequests = 0;
	const providerExtension: ExtensionFactory = pi => {
		pi.registerProvider(provider, {
			baseUrl: "http://127.0.0.1:1/v1",
			apiKey: "test-key",
			api,
			streamSimple: (model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) => {
				providerRequests++;
				const stream = new AssistantMessageEventStream();
				const message: AssistantMessage = {
					...createAssistantMessage("ok"),
					api: model.api,
					provider: model.provider,
					model: model.id,
				};
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
				return stream;
			},
			models: [
				{
					id: modelId,
					name: "Model request context journal probe",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 8192,
				},
			],
		});
	};
	const settings = Settings.isolated({ "compaction.enabled": false });
	settings.setModelRole("default", `${provider}/${modelId}`);
	const candidate: unknown = foreignRuntime
		? { runtimeIdentity: {}, rootSessionId: manager.getSessionId() }
		: candidateFor(manager.getSessionId());
	try {
		await assert.rejects(
			async () => {
				const result = await createAgentSession({
					cwd: tempDir.path(),
					agentDir: tempDir.path(),
					sessionManager: manager,
					agentRegistry: new AgentRegistry(),
					authStorage,
					modelRegistry,
					settings,
					extensions: [providerExtension],
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
					skipPythonPreflight: true,
					agentId: ROOT_AGENT_ID,
					modelRequestJournalLeaseBinding: candidate as ModelRequestJournalLeaseBinding,
				});
				publishedSession = result.session;
			},
			error => {
				assert(error instanceof Error);
				// The foreign-runtime refusal may move earlier (root-source verification
				// now rejects before any authority wording is reached); the consumer-visible
				// contract is the terminal refusal itself, no session published, and zero
				// provider I/O — asserted below. Only the fake-authority shape keeps its
				// specific verification wording.
				if (!foreignRuntime) assert.match(error.message, /Journal binding unverified/);
				startupFailure = error;
				return true;
			},
		);
		assert.equal(publishedSession, undefined);
		assert.equal(providerRequests, 0);
		// Even the rejected SDK candidate leaves the process unlatched-or-pending;
		// creating an unbound context cannot grant anything.
		assertNotGranted(createExecution());
	} finally {
		try {
			await publishedSession?.dispose();
			if (!foreignRuntime && startupFailure !== undefined) {
				// Composition latches the original failure on the File principal. Its real close
				// still releases resources, then reports that same failure to its caller. When
				// the refusal landed before the File principal created anything on disk, the
				// legitimate rejection leaves no session file to compare — that absence is
				// itself the no-I/O proof for this boundary.
				const sessionId = manager.getSessionId();
				const sessionFile = manager.getSessionFile();
				assert(sessionFile !== undefined);
				if (fs.existsSync(sessionFile)) {
					const beforeClose = fs.readFileSync(sessionFile);
					await assert.rejects(manager.close(), error => error === startupFailure);
					assert.equal(manager.getSessionId(), sessionId);
					assert.deepEqual(fs.readFileSync(sessionFile), beforeClose);
				} else {
					// Nothing latched on disk: close releases the in-memory principal, and a
					// latched failure, when present, still surfaces to its caller.
					await manager.close().then(
						() => {},
						error => assert.equal(error, startupFailure),
					);
					assert.equal(fs.existsSync(sessionFile), false);
				}
				assertNotGranted(createExecution());
			} else {
				await manager.close();
			}
		} finally {
			modelRegistry.clearSourceRegistrations("<inline-0>");
			authStorage.close();
			tempDir.removeSync();
		}
	}
}

function assertBindingPropagation(): void {
	const before = createExecution();
	assert.equal(before.journalState, "untracked");
	const binding = candidateFor("root") as ModelRequestJournalLeaseBinding;
	const assignment: ModelRequestRootAssignment = {
		kind: "child",
		rootSessionId: "root",
		modelRequestJournalLeaseBinding: binding,
	};
	assert.throws(() => resolveModelRequestRootSource(assignment), /must retain its genuine parent execution/);
	const execution = createExecution(binding);
	assertPending(execution);
	const copied: unknown = { ...binding };
	assert.throws(
		() => resolveModelRequestRootSource(assignment, copied as ModelRequestJournalLeaseBinding),
		/differs from the inherited root binding/,
	);
	assert.throws(
		() => runWithModelRequestExecution(execution, () => resolveModelRequestRootSource(undefined)),
		unavailable,
	);
	assert.throws(
		() => runWithModelRequestExecution(execution, () => resolveModelRequestRootSource(assignment, binding)),
		unavailable,
	);
	assertPending(before);
	assertPending(createExecution());
}

async function assertPromiseCannotReady(resolve: boolean): Promise<void> {
	const deferred = Promise.withResolvers<unknown>();
	// A caller-owned Promise is just another candidate, not a composition completion channel.
	const execution = createExecution(deferred.promise);
	assert.equal(execution.modelRequestJournalLeaseBinding, deferred.promise);
	assertPending(execution);
	if (resolve) {
		const fakeReady = Object.freeze({
			runtimeIdentity: modelRequestJournalAuthorityRuntimeIdentity,
			rootSessionId: "root",
			journalState: "required-ready",
			modelRequestScope: { sessionId: "root", rootSessionId: "root", purpose: "main", agent },
		});
		deferred.resolve(fakeReady);
		assert.equal(await deferred.promise, fakeReady);
		assertPending(createExecution(fakeReady));
	} else {
		const failure = new Error("registry receipt unavailable");
		const rejected = assert.rejects(deferred.promise, error => error === failure);
		deferred.reject(failure);
		await rejected;
	}
	assertPending(execution);
	assertPending(createExecution());
}

function assertFakeExecutionCannotReady(): void {
	const execution = createExecution(candidateFor("root"));
	assertPending(execution);
	const fake: unknown = Object.freeze({
		...execution,
		modelRequestJournalLeaseBinding: execution.modelRequestJournalLeaseBinding,
		journalState: "required-ready",
		modelRequestScope: { sessionId: "root", rootSessionId: "root", purpose: "main", agent },
	});
	assert.throws(() => assertJournalExecutionIdentity(fake), unavailable);
	assert.throws(() => assertJournalExecutionIdentity(fake, execution), unavailable);
	assert.throws(() => assertJournalExecutionIdentity(execution, fake as ModelRequestExecution), unavailable);
	assert.throws(() => assertJournalExecutionReady(fake as ModelRequestExecution), unavailable);
	assert.throws(() => childModelRequestRootOf(fake as ModelRequestExecution), unavailable);
	assert.throws(
		() =>
			resolveModelRequestRootSource({
				kind: "child",
				rootSessionId: "root",
				modelRequestJournalLeaseBinding: execution.modelRequestJournalLeaseBinding,
				parentExecution: fake as ModelRequestExecution,
			}),
		unavailable,
	);
	assertPending(execution);
}

async function assertGenuineParentHandover(): Promise<void> {
	// Real fixed-verifier fixture: no binding, ready setter or receipt issuer is mocked.
	const temp = TempDir.createSync("@pi-genuine-parent-");
	const directory = fs.realpathSync(temp.path());
	const databasePath = path.join(directory, "state.sqlite3");
	fs.writeFileSync(databasePath, "", { mode: 0o600 });
	const db = openModelRequestJournalDatabase(databasePath, { strict: true, safeIntegers: false });
	const storeId = `test-${randomUUID()}`;
	const writerId = `writer-${randomUUID()}`;
	const requester = Object.freeze({ writerId });
	const token = randomBytes(32);
	const hash = createHash("sha256").update(token).digest("hex");
	const physicalBindingId = randomUUID();
	retainModelRequestWriterCredential(requester, { writerId, token, role: "operator-command", capabilities: [] });
	const common =
		"seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,tx_seq INTEGER NOT NULL,created_at_ms INTEGER NOT NULL";
	db.exec(`PRAGMA journal_mode=WAL; PRAGMA application_id=1330856277; PRAGMA user_version=20;
		CREATE TABLE store_meta(singleton INTEGER PRIMARY KEY,store_id TEXT) STRICT;
		CREATE TABLE tx_log(tx_seq INTEGER PRIMARY KEY,writer_id TEXT,op_name TEXT,sealed INTEGER) STRICT;
		CREATE TABLE writer(${common},role TEXT NOT NULL,capabilities_json TEXT NOT NULL,agent_kind TEXT,omp_agent_id TEXT,depth INTEGER,parent_writer_id TEXT,omp_session_id TEXT,token_hash TEXT NOT NULL,host_pid INTEGER,component_version_id TEXT) STRICT;
		CREATE TABLE writer_event(${common},writer_id TEXT NOT NULL,event TEXT NOT NULL,reason TEXT) STRICT;
		CREATE TABLE store_config_event(${common},key TEXT NOT NULL,value_json TEXT NOT NULL,approval_id TEXT,writer_id TEXT NOT NULL) STRICT;`);
	db.query("INSERT INTO store_meta VALUES(1,?)").run(storeId);
	db.query("INSERT INTO tx_log VALUES(1,?,'store.init',1),(2,?,'bootstrapModelRequestJournalAuthority',1)").run(
		writerId,
		writerId,
	);
	db.query(
		"INSERT INTO writer(id,tx_seq,created_at_ms,role,capabilities_json,token_hash) VALUES(?,1,1,'operator-command','[]',?)",
	).run(writerId, hash);
	db.query(
		"INSERT INTO store_config_event(id,tx_seq,created_at_ms,key,value_json,approval_id,writer_id) VALUES('epoch-1',2,2,'budget_authority_epoch',?,NULL,?)",
	).run(JSON.stringify({ schemaVersion: 1, authorityEpoch: 1, physicalBindingId }), writerId);
	let namespace: string | undefined;
	const cells: FileJournalCell[] = [];
	const openCell = () => {
		const cell = openFileJournalCell({ cwd: directory, sessionDir: path.join(directory, "sessions") });
		cells.push(cell);
		return cell;
	};
	try {
		await withRawModelRequestJournalLeases({ storeId, control: "exclusive", maintenance: "exclusive" }, async raw => {
			namespace = raw.namespacePath;
			const identity = fs.statSync(databasePath);
			fs.writeFileSync(
				raw.recordPath,
				JSON.stringify({
					schemaVersion: 1,
					storeId,
					authorityEpoch: 1,
					physicalBindingId,
					dbDevice: identity.dev,
					dbInode: identity.ino,
					state: "active",
				}),
				{ mode: 0o600 },
			);
		});
		const root = openCell();
		await withVerifiedModelRequestJournalBinding(
			{
				resources: { storeId, databasePath },
				requester,
				mode: "bootstrap-new",
				rootSessionId: root.getSessionId(),
			},
			async binding => {
				const parent = createSessionModelRequestExecution({
					getSessionId: () => root.getSessionId(),
					root: resolveModelRequestRootSource(undefined, binding),
					agent,
				});
				await composeJournalSession({ cell: root, root, binding, execution: parent });
				const handover = childModelRequestRootOf(parent);
				assert(Object.isFrozen(handover));
				assert.equal(handover.parentExecution, parent);
				assert.equal(handover.rootSessionId, root.getSessionId());
				const explicitSource = resolveModelRequestRootSource(handover);
				assert.equal(explicitSource.kind, "inherited");
				if (explicitSource.kind !== "inherited") throw new Error("expected inherited root");
				assert.equal(explicitSource.parentExecution, parent);
				const childCell = openCell();
				const child = createSessionModelRequestExecution({
					getSessionId: () => childCell.getSessionId(),
					root: explicitSource,
					agent: { kind: "sub", id: "Child", name: "child", depth: 1, parentId: ROOT_AGENT_ID },
				});
				await composeJournalSession({ cell: childCell, root, binding, execution: child });
				assertJournalExecutionReady(child);
				assert.equal(childModelRequestRootOf(child).parentExecution, child);
				const alias = deriveModelRequestExecution(parent, { purpose: "advisor" });
				assert.notEqual(alias, parent);
				assertJournalExecutionIdentity(parent, alias);
				assertJournalExecutionIdentity(alias, parent);
				const aliasHandover = childModelRequestRootOf(alias);
				assert.equal(aliasHandover.parentExecution, alias);
				runWithModelRequestExecution(parent, () => {
					const source = resolveModelRequestRootSource(aliasHandover);
					assert.equal(source.kind === "inherited" && source.parentExecution, alias);
				});
				await runWithModelRequestExecution(alias, async () => {
					const source = resolveModelRequestRootSource(handover);
					assert.equal(source.kind === "inherited" && source.parentExecution, parent);
					const derivedChildCell = openCell();
					const derivedChild = createSessionModelRequestExecution({
						getSessionId: () => derivedChildCell.getSessionId(),
						root: source,
						agent: { kind: "sub", id: "DerivedChild", name: "child", depth: 1, parentId: ROOT_AGENT_ID },
					});
					await composeJournalSession({ cell: derivedChildCell, root, binding, execution: derivedChild });
					assertJournalExecutionReady(derivedChild);
					assert.equal(childModelRequestRootOf(derivedChild).parentExecution, derivedChild);
					await derivedChildCell.close();
				});
				// A child has its own family even though the actual binding and root are shared.
				assert.equal(child.modelRequestJournalLeaseBinding, parent.modelRequestJournalLeaseBinding);
				assert.equal(resolveModelRequestScope(child).rootSessionId, resolveModelRequestScope(parent).rootSessionId);
				assertJournalExecutionIdentity(child);
				assert.throws(() => assertJournalExecutionIdentity(parent, child), unavailable);
				assert.throws(() => assertJournalExecutionIdentity(child, parent), unavailable);
				const childHandover = childModelRequestRootOf(child);
				assert.throws(
					() => runWithModelRequestExecution(child, () => resolveModelRequestRootSource(handover)),
					unavailable,
				);
				assert.throws(
					() => runWithModelRequestExecution(parent, () => resolveModelRequestRootSource(childHandover)),
					unavailable,
				);
				assert.throws(
					() =>
						runWithModelRequestExecution(alias, () =>
							resolveModelRequestRootSource({
								...handover,
								parentExecution: undefined,
							}),
						),
					/genuine parent/,
				);
				const fake: unknown = Object.freeze({ ...parent });
				assert.throws(() => assertJournalExecutionIdentity(fake, parent), unavailable);
				assert.throws(() => assertJournalExecutionIdentity(parent, fake as ModelRequestExecution), unavailable);
				assert.throws(
					() =>
						runWithModelRequestExecution(alias, () =>
							resolveModelRequestRootSource({
								...handover,
								parentExecution: fake as ModelRequestExecution,
							}),
						),
					unavailable,
				);
				assert.throws(
					() => resolveModelRequestRootSource({ ...handover, parentExecution: undefined }),
					/genuine parent/,
				);
				assert.throws(
					() => resolveModelRequestRootSource({ ...handover, rootSessionId: "another-root" }),
					/differs/,
				);
				await childCell.close();
				await root.close();
				// Pure family identity survives revocation but never grants readiness or revives a handover.
				assertJournalExecutionIdentity(parent);
				assertJournalExecutionIdentity(parent, alias);
				assertJournalExecutionIdentity(alias, parent);
				assert.throws(() => assertJournalExecutionReady(parent), unavailable);
				assert.throws(() => assertJournalExecutionReady(alias), unavailable);
				assert.throws(() => resolveModelRequestRootSource(handover), unavailable);
				assert.throws(() => childModelRequestRootOf(child), unavailable);
			},
		);
	} finally {
		for (const cell of cells.reverse()) await cell.close();
		retireModelRequestWriterCredential(requester);
		db.close();
		temp.removeSync();
		if (namespace !== undefined) fs.rmSync(namespace, { recursive: true, force: true });
	}
}

const scenario = process.argv[2];
switch (scenario) {
	case "foreign-runtime":
		await assertSdkRefusesCandidate(true);
		break;
	case "fake-authority":
		await assertSdkRefusesCandidate(false);
		break;
	case "binding-propagation":
		assertBindingPropagation();
		break;
	case "rejected-promise":
		await assertPromiseCannotReady(false);
		break;
	case "resolved-promise":
		await assertPromiseCannotReady(true);
		break;
	case "fake-execution":
		assertFakeExecutionCannotReady();
		break;
	case "genuine-parent":
		await assertGenuineParentHandover();
		break;
	default:
		throw new Error(`Unknown model request context probe: ${scenario}`);
}
console.log(`model-request-context:${scenario}:ok`);
