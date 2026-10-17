/**
 * Managed native journal + gate outer-work regressions only.
 *
 * One argv scenario per fresh child process (`--preload` audit bootstrap). Do not
 * add genuine-untracked `beginJournalExecutionWork` probes here: after bootstrap
 * the required latch is irreversible in-process (see utils
 * `model-request-journal-outer-work-untracked.suite.ts` for untracked proof).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelRequestOutcome } from "@oh-my-pi/pi-utils/model-request-data";
import {
	retainModelRequestWriterCredential,
	withVerifiedModelRequestJournalBinding,
} from "@oh-my-pi/pi-utils/model-request-journal-authority";
import {
	assertJournalExecutionReady,
	closeJournalSession,
	composeJournalSession,
	openFileJournalCell,
} from "@oh-my-pi/pi-utils/model-request-journal-composition";
import { withRawModelRequestJournalLeases } from "@oh-my-pi/pi-utils/model-request-journal-leases";
import { openModelRequestJournalDatabase } from "@oh-my-pi/pi-utils/model-request-journal-sqlite-control";
import {
	registerModelRequestGate,
	type ModelRequestDecision,
	type ModelRequestLease,
} from "../../src/model-request-gate";
import { getModelRequestRuntime } from "../../src/model-request-runtime";
import { registerCustomApi } from "../../src/api-registry";
import { createMockModel, registerMockApi, streamMock } from "../../src/providers/mock";
import { AssistantMessageEventStream } from "../../src/utils/event-stream";
import { __providerInFlightForTesting, stream, streamSimple } from "../../src/stream";
import type { Context } from "../../src/types";
import { gatedSend } from "../../src/utils/model-request-fetch";
import { modelRequestBuiltinFetch } from "../../src/utils/model-request-builtin-fetch";
import { transportFetch } from "../../src/utils/transport-fetch";
import {
	errorReply,
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
	"gate-decision-unrecognizable",
	"gate-deny-outer-rejected",
	"a01-tf-debug-holds-wire",
	"a02-inflight-heartbeat-flush-pending",
	"a02-inflight-remove-lease-reject",
	"a02-inflight-release-joins-raw",
	"a03-header-resolver-pending",
	"a03-header-resolver-reject",
	"a04-auth-retry-recovered-fulfilled",
	"a04-auth-retry-unrecovered-rejected",
	"a05-uninstrumented-wrapper-pending",
	"a06-leaked-thinking-inner-pending",
	"a06-thinking-loop-inner-pending",
] as const;

function streamContext(): Context {
	return { systemPrompt: [], messages: [{ role: "user", content: "hi", timestamp: 0 }] };
}
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
		case "gate-decision-unrecognizable": {
			registerModelRequestGate(
				"outer-lifetime",
				{ authorize: async () => ({ type: "not-a-decision" }) as ModelRequestDecision },
				undefined,
			);
			const model = loopbackModel("openai-completions", "http://127.0.0.1:9");
			return withReady(async ({ close }) => {
				let failure: unknown;
				try {
					await runtime.authorize({
						requestId: randomUUID(),
						reason: "user",
						kind: "chat",
						model,
						wire: undefined,
					});
				} catch (error) {
					failure = error;
				}
				await close();
				return {
					message: failure instanceof Error ? failure.message : String(failure),
				};
			});
		}
		case "gate-deny-outer-rejected": {
			registerModelRequestGate(
				"outer-lifetime",
				{ authorize: async () => ({ type: "deny", code: "budget", message: "over budget" }) },
				undefined,
			);
			const model = loopbackModel("openai-completions", "http://127.0.0.1:9");
			return withReady(async ({ close }) => {
				let code = "";
				try {
					await runtime.authorize({
						requestId: randomUUID(),
						reason: "user",
						kind: "chat",
						model,
						wire: undefined,
					});
				} catch (error) {
					code = error instanceof Error ? error.message : String(error);
				}
				let closeError: string | undefined;
				try {
					await close();
				} catch (error) {
					closeError = error instanceof Error ? error.message : String(error);
				}
				return { denied: code.includes("over budget"), closeError };
			});
		}
		case "a01-tf-debug-holds-wire": {
			Bun.env.PI_REQ_DEBUG = "1";
			registerModelRequestGate("outer-lifetime", { authorize: () => ({ type: "pass" }) }, undefined);
			const holdBody = Promise.withResolvers<void>();
			const loopback = await startLoopbackProvider(scripted(textReplyFor("dbg")));
			const model = loopbackModel("openai-completions", loopback.origin);
			const url = `${loopback.origin}/v1/chat/completions`;
			return withReady(async ({ close }) => {
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						void holdBody.promise.then(() => {
							controller.enqueue(new TextEncoder().encode(JSON.stringify(helloContext())));
							controller.close();
						});
					},
				});
				const tf = transportFetch(model, modelRequestBuiltinFetch);
				const inflight = tf(url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body,
				});
				await Bun.sleep(30);
				const wireBefore = loopback.requests.length;
				const closeRace = await Promise.race([
					close().then(() => "closed" as const),
					new Promise<"pending">(resolve => setTimeout(() => resolve("pending"), 100)),
				]);
				holdBody.resolve();
				await inflight;
				await close();
				loopback.stop();
				delete Bun.env.PI_REQ_DEBUG;
				return { wireBefore, closeRace };
			});
		}
		case "a02-inflight-heartbeat-flush-pending": {
			registerMockApi();
			const root = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-ol-inflight-"));
			__providerInFlightForTesting.setRoot(root);
			__providerInFlightForTesting.setHeartbeatTimings({ heartbeatMs: 5, heartbeatFlushTimeoutMs: 25 });
			const resumeHeartbeat = Promise.withResolvers<void>();
			__providerInFlightForTesting.setHeartbeatWriter(async write => {
				await resumeHeartbeat.promise;
				await write();
			});
			const started = Promise.withResolvers<void>();
			const finish = Promise.withResolvers<void>();
			const mock = createMockModel({
				provider: "tests",
				handler: async () => {
					started.resolve();
					await finish.promise;
					return { content: ["ok"] };
				},
			});
			return withReady(async ({ close }) => {
				const s = streamSimple(mock.model, streamContext(), { maxInFlightRequests: { tests: 1 } });
				const result = s.result();
				await started.promise;
				finish.resolve();
				const msg = await result;
				resumeHeartbeat.resolve();
				await close();
				await fsp.rm(root, { recursive: true, force: true });
				__providerInFlightForTesting.setRoot(undefined);
				__providerInFlightForTesting.setHeartbeatTimings(undefined);
				__providerInFlightForTesting.setHeartbeatWriter(undefined);
				return { text: msg.content[0] };
			});
		}
		case "a02-inflight-remove-lease-reject": {
			registerMockApi();
			const root = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-ol-inflight-"));
			__providerInFlightForTesting.setRoot(root);
			__providerInFlightForTesting.setLeaseRemover(async () => {
				throw Object.assign(new Error("simulated lease removal failure"), { code: "EBUSY" });
			});
			const mock = createMockModel({
				provider: "tests",
				handler: async () => ({ content: ["ok"] }),
			});
			return withReady(async ({ close }) => {
				const msg = await streamSimple(mock.model, streamContext(), {
					maxInFlightRequests: { tests: 1 },
				}).result();
				let closeError: string | undefined;
				try {
					await close();
				} catch (error) {
					closeError = error instanceof Error ? error.message : String(error);
				}
				await fsp.rm(root, { recursive: true, force: true });
				__providerInFlightForTesting.setRoot(undefined);
				__providerInFlightForTesting.setLeaseRemover(undefined);
				return { text: msg.content[0], closeError };
			});
		}
		case "a02-inflight-release-joins-raw": {
			registerMockApi();
			const root = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-ol-inflight-"));
			__providerInFlightForTesting.setRoot(root);
			const firstStarted = Promise.withResolvers<void>();
			const releaseFirst = Promise.withResolvers<void>();
			let callIndex = 0;
			const mock = createMockModel({
				provider: "tests",
				handler: async () => {
					callIndex++;
					if (callIndex === 1) {
						firstStarted.resolve();
						await releaseFirst.promise;
					}
					return { content: [`r${callIndex}`] };
				},
			});
			return withReady(async ({ close }) => {
				const first = streamSimple(mock.model, streamContext(), { maxInFlightRequests: { tests: 1 } });
				const firstResult = first.result();
				await firstStarted.promise;
				const second = streamSimple(mock.model, streamContext(), { maxInFlightRequests: { tests: 1 } });
				const secondResult = second.result();
				await Bun.sleep(50);
				const blocked = await Promise.race([
					close().then(() => "closed" as const),
					new Promise<"pending">(resolve => setTimeout(() => resolve("pending"), 80)),
				]);
				releaseFirst.resolve();
				await Promise.all([firstResult, secondResult]);
				await close();
				await fsp.rm(root, { recursive: true, force: true });
				__providerInFlightForTesting.setRoot(undefined);
				return { blocked, calls: callIndex };
			});
		}
		case "a03-header-resolver-pending": {
			registerModelRequestGate("outer-lifetime", { authorize: () => ({ type: "pass" }) }, undefined);
			const hold = Promise.withResolvers<void>();
			const loopback = await startLoopbackProvider(scripted(textReplyFor("hdr")));
			const base = loopbackModel("openai-completions", loopback.origin);
			const model = {
				...base,
				resolveHeaders: async () => {
					await hold.promise;
					return { "x-ol": "1" };
				},
			};
			return withReady(async ({ close }) => {
				const outer = stream(model, streamContext(), {
					fetch: transportFetch(base, modelRequestBuiltinFetch),
				});
				const pending = await Promise.race([
					close().then(() => "closed" as const),
					new Promise<"pending">(resolve => setTimeout(() => resolve("pending"), 80)),
				]);
				hold.resolve();
				await outer.result();
				await close();
				loopback.stop();
				return { pending };
			});
		}
		case "a03-header-resolver-reject": {
			registerModelRequestGate("outer-lifetime", { authorize: () => ({ type: "pass" }) }, undefined);
			const reject = new Error("header resolver failed");
			const loopback = await startLoopbackProvider(scripted(textReplyFor("hdr")));
			const base = loopbackModel("openai-completions", loopback.origin);
			const model = {
				...base,
				resolveHeaders: async () => {
					throw reject;
				},
			};
			return withReady(async ({ close }) => {
				let failure: unknown;
				try {
					await stream(model, streamContext(), {
						fetch: transportFetch(base, modelRequestBuiltinFetch),
					}).result();
				} catch (error) {
					failure = error;
				}
				let closeError: string | undefined;
				try {
					await close();
				} catch (error) {
					closeError = error instanceof Error ? error.message : String(error);
				}
				loopback.stop();
				return { failure: failure === reject, closeError };
			});
		}
		case "a04-auth-retry-recovered-fulfilled": {
			registerModelRequestGate("outer-lifetime", { authorize: () => ({ type: "pass" }) }, undefined);
			const loopback = await startLoopbackProvider((_req, i) =>
				i === 0 ? errorReply(401, "bad key") : textReplyFor("recovered"),
			);
			const model = loopbackModel("openai-completions", loopback.origin);
			return withReady(async ({ close }) => {
				const msg = await streamSimple(model, streamContext(), {
					apiKey: async ({ lastChance }) => (lastChance ? "key-rotate" : "key-first"),
					fetch: transportFetch(model, modelRequestBuiltinFetch),
				}).result();
				await close();
				loopback.stop();
				return { stopReason: msg.stopReason, wireAttempts: loopback.requests.length };
			});
		}
		case "a04-auth-retry-unrecovered-rejected": {
			registerModelRequestGate("outer-lifetime", { authorize: () => ({ type: "pass" }) }, undefined);
			const loopback = await startLoopbackProvider(scripted(errorReply(401, "bad key")));
			const model = loopbackModel("openai-completions", loopback.origin);
			return withReady(async ({ close }) => {
				let failed = false;
				try {
					await streamSimple(model, streamContext(), {
						apiKey: async ({ lastChance }) => (lastChance ? undefined : "key-first"),
						fetch: transportFetch(model, modelRequestBuiltinFetch),
					}).result();
				} catch {
					failed = true;
				}
				let closeError: string | undefined;
				try {
					await close();
				} catch (error) {
					closeError = error instanceof Error ? error.message : String(error);
				}
				loopback.stop();
				return { failed, closeError };
			});
		}
		case "a05-uninstrumented-wrapper-pending": {
			registerModelRequestGate("outer-lifetime", { authorize: () => ({ type: "pass" }) }, undefined);
			const hold = Promise.withResolvers<void>();
			const api = `ol-ext-${randomUUID()}`;
			registerCustomApi(api, (model, context, options) => {
				const outer = new AssistantMessageEventStream();
				void (async () => {
					await hold.promise;
					const inner = streamMock(model, context, options);
					for await (const event of inner) {
						outer.push(event);
						if (outer.done) return;
					}
					if (!outer.done) outer.end(await inner.result());
				})().catch(error => outer.fail(error));
				return outer;
			});
			const mock = createMockModel({ provider: "ol-ext", handler: async () => ({ content: ["ext"] }) });
			const model = { ...mock.model, api, provider: "ol-ext" };
			return withReady(async ({ close }) => {
				const outer = stream(model, streamContext());
				const pending = await Promise.race([
					close().then(() => "closed" as const),
					new Promise<"pending">(resolve => setTimeout(() => resolve("pending"), 80)),
				]);
				hold.resolve();
				await outer.result();
				await close();
				return { pending };
			});
		}
		case "a06-leaked-thinking-inner-pending": {
			registerMockApi();
			const hold = Promise.withResolvers<void>();
			const mock = createMockModel({
				provider: "openrouter",
				handler: async () => {
					await hold.promise;
					return { content: ["```thinking\nx\n```", "answer"] };
				},
			});
			return withReady(async ({ close }) => {
				const outer = streamSimple(mock.model, streamContext());
				const pending = await Promise.race([
					close().then(() => "closed" as const),
					new Promise<"pending">(resolve => setTimeout(() => resolve("pending"), 80)),
				]);
				hold.resolve();
				await outer.result();
				await close();
				return { pending };
			});
		}
		case "a06-thinking-loop-inner-pending": {
			registerMockApi();
			const hold = Promise.withResolvers<void>();
			const mock = createMockModel({
				provider: "tests",
				handler: async () => {
					await hold.promise;
					return { content: ["short ok"] };
				},
			});
			return withReady(async ({ close }) => {
				const outer = streamSimple(mock.model, streamContext());
				const pending = await Promise.race([
					close().then(() => "closed" as const),
					new Promise<"pending">(resolve => setTimeout(() => resolve("pending"), 80)),
				]);
				hold.resolve();
				await outer.result();
				await close();
				return { pending };
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
