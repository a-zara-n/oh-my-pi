import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { ModelRequestOutcome } from "@oh-my-pi/pi-utils/model-request-data";
import {
	retainModelRequestWriterCredential,
	retainVerifiedModelRequestJournalRoot,
	retireModelRequestWriterCredential,
	withVerifiedModelRequestJournalBinding,
	type ModelRequestJournalLeaseBinding,
} from "@oh-my-pi/pi-utils/model-request-journal-authority";
import {
	assertJournalExecutionReady,
	beginJournalSend,
	closeJournalSession,
	composeJournalSession,
	endJournalSendStart,
	openFileJournalCell,
	prepareJournalSend,
	type FileJournalCell,
	type ModelRequestExecution,
} from "@oh-my-pi/pi-utils/model-request-journal-composition";
import { withRawModelRequestJournalLeases } from "@oh-my-pi/pi-utils/model-request-journal-leases";
import { openModelRequestJournalDatabase } from "@oh-my-pi/pi-utils/model-request-journal-sqlite-control";
import { registerModelRequestGate, type ModelRequestLease } from "../../src/model-request-gate";
import { getModelRequestRuntime } from "../../src/model-request-runtime";
import { complete } from "../../src/stream";
import { modelRequestBuiltinFetch } from "../../src/utils/model-request-builtin-fetch";
import { buildModelRequestWire, gatedSend, gateFetch, markFetchGated } from "../../src/utils/model-request-fetch";
import { transportFetch } from "../../src/utils/transport-fetch";
import { helloContext, loopbackModel, startLoopbackProvider, textReplyFor } from "../helpers/model-request-loopback";

// Each invocation gets a fresh monotonic gate latch. The --preload is mandatory:
// no environment flag, replacement fetch, or test-issued ready/binding proof is used.
const runtime = getModelRequestRuntime();
const scenario = process.argv[2];
const scenarios = [
	"no-gate",
	"pass",
	"deny",
	"abort-gate",
	"begin-abort",
	"begin-revoke",
	"custom-sender",
	"fake-supplied",
	"forged-authorize",
	"leaf-replay",
	"same-stack-release",
	"dispatch-before-revoke",
	"gate-await-revoke",
	"begin-epoch-change",
	"begin-database-close",
	"prepare-await-revoke",
	"authorize-accessor",
	"marked-before-required",
	"forged-transport-stamp",
	"internal-current-accessor",
] as const;
if (!scenarios.some(value => value === scenario)) throw new Error("unknown trusted dispatch scenario");
let auxiliaryTwinCalls = 0;
// Construct before opening the owned journal factory latches this process.
// Public registration of the real builtin must not permanently remove its
// future invocation from the required dispatcher.
const markedBeforeRequired =
	scenario === "marked-before-required"
		? gateFetch(
				loopbackModel("openai-completions", "http://127.0.0.1:9"),
				"chat",
				markFetchGated(modelRequestBuiltinFetch, async () => {
					auxiliaryTwinCalls++;
					throw new Error("model dispatch must not call the arbitrary auxiliary twin");
				}),
			)
		: undefined;

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
	// A failure watchdog for a real subprocess/network/native-lock integration,
	// never a sleep or an ordering signal; success awaits the actual event.
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error(`${label} did not finish`)), 10_000);
	try {
		return await Promise.race([promise, deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}

interface ReadyContext {
	readonly binding: ModelRequestJournalLeaseBinding;
	readonly cell: FileJournalCell;
	readonly execution: ModelRequestExecution;
	readonly registryId: string;
	revoke(): Promise<void>;
	changeAuthorityEpoch(): void;
	closeAuthorityDatabase(): void;
	assertPhysicalRootReleased(): void;
}

// One scenario runs per child. Keep the actual rejected operation, not a
// message-only approximation, for the binding finalizer's retained-failure check.
let prepareAwaitRevocationFailure: Error | undefined;

async function withReadyRoot(use: (context: ReadyContext) => Promise<object>): Promise<object> {
	const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "d37-trusted-dispatch-")));
	const cell = openFileJournalCell({ cwd: directory, sessionDir: path.join(directory, "sessions") });
	const rootSessionId = cell.getSessionId();
	const agent = Object.freeze({ id: `main-${randomUUID()}`, name: "main", kind: "main" as const, depth: 0 });
	const storeId = `test-${randomUUID()}`;
	const databasePath = path.join(directory, "state.sqlite3");
	fs.writeFileSync(databasePath, "", { mode: 0o600 });
	const database = openModelRequestJournalDatabase(databasePath, { strict: true, safeIntegers: false });
	fs.chmodSync(databasePath, 0o600);
	const writerId = `writer-${randomUUID()}`;
	const epochWriterId = `writer-${randomUUID()}`;
	const requester = Object.freeze({ writerId });
	const token = randomBytes(32);
	const physicalBindingId = randomUUID();
	let namespace: string | undefined;
	let credentialRetained = false;
	let databaseClosed = false;
	let authorityMutation: "epoch" | "writer-close" | undefined;
	let result: object | undefined;
	const cleanupAuthorityErrors: string[] = [];
	let prepareRegistryId: string | undefined;
	let prepareCleanup: object | undefined;
	let finalizerRootReleased = false;
	try {
		retainModelRequestWriterCredential(requester, {
			writerId,
			token,
			role: "harness-core",
			capabilities: [],
			identity: { sessionId: rootSessionId, id: agent.id, kind: agent.kind, depth: agent.depth },
		});
		credentialRetained = true;
		// Real schema/token/epoch rows consumed by the fixed native verifier. The
		// writable connection stays open for its actual owned writer generation.
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
		});
		try {
			await withVerifiedModelRequestJournalBinding(
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
						if (execution.journalState !== "required-ready")
							throw new Error("real File composition did not become ready");
						const registry = cell.getHeader().modelRequestRegistry;
						if (registry === undefined) throw new Error("real root registry missing");
						if (scenario === "prepare-await-revoke") prepareRegistryId = registry.registryId;
						let closing: Promise<void> | undefined;
						const revoke = (): Promise<void> => (closing ??= closeJournalSession(session));
						try {
							result = await use({
								binding,
								cell,
								execution,
								registryId: registry.registryId,
								revoke,
								changeAuthorityEpoch() {
									database
										.query("UPDATE store_config_event SET value_json=? WHERE id='epoch-1'")
										.run(JSON.stringify({ schemaVersion: 1, authorityEpoch: 2, physicalBindingId }));
									// Deliberately leave the actual raw authority record at epoch 1.
									authorityMutation = "epoch";
								},
								closeAuthorityDatabase() {
									database.close();
									databaseClosed = true;
									authorityMutation = "writer-close";
								},
								assertPhysicalRootReleased() {
									// The invalidated authority must not issue another verified scope.
									// A real raw lock acquisition still proves the short root was freed.
									withRawModelRequestJournalLeases(
										{
											storeId,
											control: "shared",
											maintenance: "shared",
											ownerId: writerId,
											registryId: registry.registryId,
										},
										raw => {
											if (raw.registryId !== registry.registryId)
												throw new Error("physical root identity changed");
											raw.assertHeld();
										},
									);
								},
							});
							return result;
						} finally {
							try {
								await revoke();
							} catch (error) {
								if (authorityMutation === undefined || result === undefined) throw error;
								cleanupAuthorityErrors.push(error instanceof Error ? error.message : String(error));
							}
						}
					});
				},
			);
		} catch (error) {
			if (scenario === "prepare-await-revoke" && result !== undefined) {
				const prepareFailure = prepareAwaitRevocationFailure;
				if (
					prepareFailure === undefined ||
					prepareRegistryId === undefined ||
					!(error instanceof AggregateError) ||
					error.message !== "Journal principal drains failed"
				)
					throw error;
				const drains: readonly unknown[] = error.errors;
				const graph = drains[0];
				if (
					drains.length !== 1 ||
					!(graph instanceof AggregateError) ||
					graph.message !== "Journal bound principal graph failed"
				)
					throw error;
				const causes: readonly unknown[] = graph.errors;
				// Any additional or substituted cleanup failure remains an uncaught
				// failure. Only this exact prepare rejection is expected here.
				if (causes.length !== 1 || causes[0] !== prepareFailure) throw error;
				prepareCleanup = {
					name: error.name,
					message: error.message,
					errors: [
						{
							name: graph.name,
							message: graph.message,
							errors: [
								{
									name: prepareFailure.name,
									message: prepareFailure.message,
									samePrepareRejection: causes[0] === prepareFailure,
								},
							],
						},
					],
				};
				cleanupAuthorityErrors.push(error.message);
				// Probe after the rejected binding finalizer has actually exited,
				// independently of the earlier verified-root reacquisition.
				withRawModelRequestJournalLeases(
					{
						storeId,
						control: "shared",
						maintenance: "shared",
						ownerId: writerId,
						registryId: prepareRegistryId,
					},
					raw => {
						if (raw.registryId !== prepareRegistryId) throw new Error("physical root identity changed");
						raw.assertHeld();
					},
				);
				finalizerRootReleased = true;
			} else {
				if (authorityMutation === undefined || result === undefined) throw error;
				cleanupAuthorityErrors.push(error instanceof Error ? error.message : String(error));
			}
		}
	} finally {
		try {
			await cell.close();
		} catch (error) {
			if (authorityMutation === undefined || result === undefined) throw error;
			cleanupAuthorityErrors.push(error instanceof Error ? error.message : String(error));
		} finally {
			try {
				if (credentialRetained) retireModelRequestWriterCredential(requester);
			} finally {
				try {
					if (!databaseClosed) database.close();
				} finally {
					fs.rmSync(directory, { recursive: true, force: true });
					if (namespace !== undefined) fs.rmSync(namespace, { recursive: true, force: true });
				}
			}
		}
	}
	if (result === undefined) throw new Error("required-ready scenario produced no result");
	if (scenario === "prepare-await-revoke") {
		if (prepareCleanup === undefined) throw new Error("Binding drain did not retain the rejected prepare");
		return {
			...result,
			authorityMutation,
			cleanupAuthorityErrors,
			prepareCleanup,
			bindingDrainRejected: true,
			finalizerRootReleased,
		};
	}
	return { ...result, authorityMutation, cleanupAuthorityErrors };
}

function acquireAndReleaseRoot(context: ReadyContext): void {
	const scope = retainVerifiedModelRequestJournalRoot(context.binding, context.registryId);
	try {
		scope.assertActive();
	} finally {
		scope.release();
	}
}

async function leafRegressions(context: ReadyContext): Promise<object> {
	const model = loopbackModel("openai-completions", "http://127.0.0.1:9");
	const authorize = () =>
		runtime.authorize({
			requestId: randomUUID(),
			reason: "first",
			kind: "chat",
			model,
			wire: buildModelRequestWire("http://127.0.0.1:9", undefined),
		});
	const permit = await authorize();
	const admission = await prepareJournalSend(context.execution, permit);
	let begun = false;
	try {
		beginJournalSend(admission, context.execution, permit);
		begun = true;
	} finally {
		endJournalSendStart(admission);
	}
	let replayRejected = false;
	try {
		beginJournalSend(admission, context.execution, permit);
	} catch {
		replayRejected = true;
	}
	// Ending twice must not resurrect or retain a root.
	endJournalSendStart(admission);
	acquireAndReleaseRoot(context);
	let endedPrepareRejected = false;
	try {
		const replay = await prepareJournalSend(context.execution, permit);
		endJournalSendStart(replay);
	} catch {
		endedPrepareRejected = true;
	}

	const otherExecution = runtime.deriveExecution(context.execution, { purpose: "advisor" });
	const mismatchPermit = await authorize();
	const mismatchAdmission = await prepareJournalSend(context.execution, mismatchPermit);
	let executionMismatchRejected = false;
	try {
		beginJournalSend(mismatchAdmission, otherExecution, mismatchPermit);
	} catch {
		executionMismatchRejected = true;
	} finally {
		endJournalSendStart(mismatchAdmission);
	}
	acquireAndReleaseRoot(context);

	const otherPermit = await authorize();
	const attemptAdmission = await prepareJournalSend(context.execution, otherPermit);
	let attemptMismatchRejected = false;
	try {
		beginJournalSend(attemptAdmission, context.execution, Object.freeze({ attemptId: otherPermit.attemptId }));
	} catch {
		attemptMismatchRejected = true;
	} finally {
		endJournalSendStart(attemptAdmission);
	}
	acquireAndReleaseRoot(context);

	// An invalid opaque input is a negative boundary case, never a test issuer.
	let fakeAdmissionRejected = false;
	try {
		Reflect.apply(beginJournalSend, undefined, [Object.freeze({}), context.execution, otherPermit]);
	} catch {
		fakeAdmissionRejected = true;
	}
	acquireAndReleaseRoot(context);
	return {
		begun,
		replayRejected,
		endedPrepareRejected,
		executionMismatchRejected,
		attemptMismatchRejected,
		fakeAdmissionRejected,
		rootReacquired: true,
	};
}

async function dispatchRegression(context: ReadyContext): Promise<object> {
	if (scenario === "leaf-replay") return leafRegressions(context);
	if (scenario === "prepare-await-revoke") {
		const server = startLoopbackProvider(() => ({ status: 200, chunks: ["builtin-loopback"] }));
		try {
			const model = loopbackModel("openai-completions", server.origin);
			const permit = await runtime.authorize({
				requestId: randomUUID(),
				reason: "first",
				kind: "chat",
				model,
				wire: buildModelRequestWire(`${server.origin}/prepare-race`, undefined),
			});
			// No test hook: the actual async prepare starts, then the actual
			// principal close revokes its family synchronously before our await.
			const preparing = prepareJournalSend(context.execution, permit);
			const revoking = context.revoke();
			const revocation = revoking.then(
				() => ({ ok: true as const }),
				(error: unknown) => ({ ok: false as const, error }),
			);
			let preparingRejected = false;
			let admissionReturned = false;
			let admissionsIssued = 0;
			try {
				const admission = await within(preparing, "prepare interrupted by real revocation");
				admissionReturned = true;
				admissionsIssued++;
				// A mistakenly issued admission is cleaned up, never counted as
				// success: the parent asserts admissionReturned is false.
				endJournalSendStart(admission);
			} catch (error) {
				if (
					admissionReturned ||
					!(error instanceof Error) ||
					error.message !== "Model request journal capability is unavailable"
				)
					throw error;
				prepareAwaitRevocationFailure = error;
				preparingRejected = true;
			}
			const closed = await revocation;
			if (!closed.ok) throw closed.error;
			acquireAndReleaseRoot(context);
			return {
				preparingRejected,
				admissionReturned,
				admissionsIssued,
				received: server.requests.length,
				preparingError:
					prepareAwaitRevocationFailure === undefined
						? undefined
						: {
								name: prepareAwaitRevocationFailure.name,
								message: prepareAwaitRevocationFailure.message,
							},
				revocationSucceeded: closed.ok,
				rootReacquired: true,
				journalStateAfter: context.execution.journalState,
			};
		} finally {
			server.stop();
		}
	}
	const hold = Promise.withResolvers<void>();
	const held = scenario === "same-stack-release" || scenario === "dispatch-before-revoke";
	const api = scenario === "forged-transport-stamp" ? "openai-responses" : "openai-completions";
	const server = startLoopbackProvider(() =>
		scenario === "forged-transport-stamp"
			? textReplyFor(api, "core-provider-completed")
			: { status: 200, chunks: ["builtin-loopback"], ...(held ? { holdUntil: hold.promise } : {}) },
	);
	const model = loopbackModel(api, server.origin);
	const controller = new AbortController();
	const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
	const outcomes: ModelRequestOutcome[] = [];
	let gateCalls = 0;
	let beginCalls = 0;
	let responseHeads = 0;
	let chunks = 0;
	let senderCalls = 0;
	let fakeLeaseCalls = 0;
	let forgedAuthorizeCalls = 0;
	let authorizePropertyReads = 0;
	let executionPropertyReads = 0;
	let forgedExecutionCalls = 0;
	let copiedTransportSymbols = 0;
	let modelStopReason: string | undefined;
	const gatePurposes: Array<string | undefined> = [];
	const alternateExecution =
		scenario === "internal-current-accessor"
			? runtime.deriveExecution(context.execution, { purpose: "advisor" })
			: undefined;
	if (alternateExecution !== undefined) assertJournalExecutionReady(alternateExecution);
	let responseResolved = false;
	let revokePromise: Promise<void> | undefined;
	const rootProbe = Promise.withResolvers<{ acquired: boolean; responsePending: boolean; error?: string }>();
	const lease: ModelRequestLease = {
		beginSend() {
			beginCalls++;
			if (scenario === "begin-abort") controller.abort(new Error("synchronous lease abort"));
			if (scenario === "begin-revoke") revokePromise = context.revoke();
			if (scenario === "begin-epoch-change") context.changeAuthorityEpoch();
			if (scenario === "begin-database-close") context.closeAuthorityDatabase();
			if (scenario === "same-stack-release") {
				// Queued BEFORE canonical end. A release deferred to another microtask
				// loses this ordering: this actual nonblocking OS-root acquisition fails.
				queueMicrotask(() => {
					try {
						acquireAndReleaseRoot(context);
						rootProbe.resolve({ acquired: true, responsePending: !responseResolved });
					} catch (error) {
						rootProbe.resolve({
							acquired: false,
							responsePending: !responseResolved,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				});
			}
		},
		observeResponse() {
			responseHeads++;
		},
		observeChunk() {
			chunks++;
		},
		async settle(outcome) {
			outcomes.push(outcome);
		},
	};
	if (scenario !== "no-gate") {
		registerModelRequestGate("native-trusted-dispatch-regression", {
			async authorize(attempt) {
				gateCalls++;
				gatePurposes.push(attempt.scope?.purpose);
				if (scenario === "internal-current-accessor") {
					return attempt.scope?.purpose === "advisor"
						? { type: "pass" }
						: { type: "deny", code: "actual-scope-denied", message: "real gate denied the actual main scope" };
				}
				if (
					scenario === "deny" ||
					scenario === "fake-supplied" ||
					scenario === "forged-authorize" ||
					scenario === "authorize-accessor" ||
					scenario === "marked-before-required" ||
					scenario === "forged-transport-stamp"
				) {
					return { type: "deny", code: "fixture-deny", message: "real gate denied" };
				}
				if (scenario === "gate-await-revoke") {
					await context.revoke();
					return { type: "allow", lease };
				}
				if (scenario === "abort-gate") {
					controller.abort(new Error("aborted during real authorization"));
					return { type: "pass" };
				}
				if (scenario === "pass" || scenario === "custom-sender") return { type: "pass" };
				return { type: "allow", lease };
			},
		});
	}
	let rejected = false;
	let error: string | undefined;
	let body: string | undefined;
	let probe: { acquired: boolean; responsePending: boolean; error?: string } | undefined;
	let inflight: { received: number; unsettled: boolean; responsePending: boolean; journalState: string } | undefined;
	const originalAuthorize = runtime.authorize;
	const originalCurrentExecution = runtime.currentExecution;
	try {
		let invoke: () => Promise<Response | undefined>;
		if (scenario === "custom-sender") {
			const queued = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				senderCalls++;
				await Promise.resolve();
				return modelRequestBuiltinFetch(input, init);
			};
			invoke = () => transportFetch(model, queued)(`${server.origin}/custom`, { signal });
		} else if (scenario === "fake-supplied") {
			const fakePermit = Object.freeze({
				attemptId: randomUUID(),
				lease: {
					...lease,
					beginSend() {
						fakeLeaseCalls++;
					},
				},
			});
			// A public leaf can bind a genuine execution to this stable projection;
			// it does NOT authenticate gate passage. End its real root before trying
			// to smuggle the same objects into the closed canonical dispatch input.
			const suppliedAdmission = await prepareJournalSend(context.execution, fakePermit);
			endJournalSendStart(suppliedAdmission);
			const args = {
				model,
				kind: "chat" as const,
				input: `${server.origin}/fake`,
				init: { signal },
				transport: modelRequestBuiltinFetch,
				permit: fakePermit,
				admission: Object.freeze({}),
				suppliedAdmission,
				send: async () => {
					senderCalls++;
					return modelRequestBuiltinFetch(`${server.origin}/fake`, { signal });
				},
			};
			invoke = () => gatedSend(args);
		} else if (scenario === "authorize-accessor") {
			// Go directly through the actual closed dispatcher, so its runtime
			// shape read, reference check and old mutable call are reads 1/2/3.
			invoke = () =>
				gatedSend({
					model,
					kind: "chat",
					input: `${server.origin}/authorize-accessor`,
					init: { signal },
					transport: modelRequestBuiltinFetch,
					send: async () => {
						senderCalls++;
						return modelRequestBuiltinFetch(`${server.origin}/authorize-accessor`, { signal });
					},
				});
		} else if (scenario === "marked-before-required") {
			if (markedBeforeRequired === undefined) throw new Error("missing pre-required marked fetch");
			invoke = () => markedBeforeRequired(`${server.origin}/marked-before-required`, { signal });
		} else if (scenario === "forged-transport-stamp") {
			const genuine = transportFetch(model, undefined);
			const supplied = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				senderCalls++;
				return modelRequestBuiltinFetch(input, init);
			};
			for (const symbol of Object.getOwnPropertySymbols(genuine)) {
				const descriptor = Object.getOwnPropertyDescriptor(genuine, symbol);
				if (descriptor === undefined) throw new Error("genuine transport lost an own symbol");
				Object.defineProperty(supplied, symbol, descriptor);
				copiedTransportSymbols++;
			}
			// Exercise the actual stream dispatcher/provider/transport chain,
			// not just a factory's return identity.
			invoke = async () => {
				const reply = await complete(model, helloContext(), { apiKey: "loopback-key", fetch: supplied, signal });
				modelStopReason = reply.stopReason;
				if (reply.stopReason === "error" || reply.stopReason === "aborted") {
					throw new Error(reply.errorMessage ?? "core provider rejected supplied transport");
				}
				return undefined;
			};
		} else if (scenario === "internal-current-accessor") {
			invoke = () =>
				gatedSend({
					model,
					kind: "chat",
					input: `${server.origin}/internal-current-accessor`,
					init: { signal },
					transport: modelRequestBuiltinFetch,
					send: async () => {
						senderCalls++;
						return modelRequestBuiltinFetch(`${server.origin}/internal-current-accessor`, { signal });
					},
				});
		} else {
			invoke = () =>
				transportFetch(model, undefined)(`${server.origin}/builtin`, {
					method: "POST",
					body: "real-request",
					signal,
				});
		}
		if (scenario === "forged-authorize") {
			runtime.authorize = async () => {
				forgedAuthorizeCalls++;
				return { attemptId: randomUUID(), lease: undefined };
			};
		}
		if (scenario === "authorize-accessor") {
			Object.defineProperty(runtime, "authorize", {
				configurable: true,
				get() {
					authorizePropertyReads++;
					if (authorizePropertyReads !== 3) return originalAuthorize;
					return async () => {
						forgedAuthorizeCalls++;
						// Restore before private permit registration/revalidation.
						Object.defineProperty(runtime, "authorize", {
							configurable: true,
							writable: true,
							value: originalAuthorize,
						});
						return { attemptId: randomUUID(), lease: undefined };
					};
				},
			});
		}
		if (scenario === "internal-current-accessor") {
			if (alternateExecution === undefined) throw new Error("missing genuine alternate execution");
			Object.defineProperty(runtime, "currentExecution", {
				configurable: true,
				get() {
					executionPropertyReads++;
					if (executionPropertyReads !== 3 && executionPropertyReads !== 4) return originalCurrentExecution;
					return () => {
						forgedExecutionCalls++;
						if (forgedExecutionCalls === 2) {
							Object.defineProperty(runtime, "currentExecution", {
								configurable: true,
								writable: true,
								value: originalCurrentExecution,
							});
						}
						return alternateExecution;
					};
				},
			});
		}
		// Attach both continuations immediately, including on negative scenarios.
		const sending = (async () => {
			try {
				const response = await invoke();
				responseResolved = true;
				if (response !== undefined) body = await response.text();
			} catch (caught) {
				rejected = true;
				error = caught instanceof Error ? caught.message : String(caught);
			}
		})();
		if (scenario === "same-stack-release") {
			probe = await within(rootProbe.promise, "same-stack real root probe");
			await within(server.arrived(1), "actual builtin loopback arrival");
			inflight = {
				received: server.requests.length,
				unsettled: outcomes.length === 0,
				responsePending: !responseResolved,
				journalState: context.execution.journalState,
			};
			hold.resolve();
		} else if (scenario === "dispatch-before-revoke") {
			await within(server.arrived(1), "actual builtin loopback arrival before revoke");
			// Arrival is evidence of dispatch, NOT a claim about first-packet OS timing.
			revokePromise = context.revoke();
			inflight = {
				received: server.requests.length,
				unsettled: outcomes.length === 0,
				responsePending: !responseResolved,
				journalState: context.execution.journalState,
			};
			controller.abort(new Error("revoke after actual builtin dispatch"));
		}
		await within(sending, "canonical dispatch settlement");
		if (revokePromise !== undefined) await revokePromise;
		// Let a wrongly invoked queued sender reach the loopback before counting.
		await setImmediate();
		await setImmediate();
		let verifiedReacquireRejected = false;
		if (scenario === "begin-epoch-change" || scenario === "begin-database-close") {
			try {
				acquireAndReleaseRoot(context);
			} catch {
				verifiedReacquireRejected = true;
			}
			context.assertPhysicalRootReleased();
		} else acquireAndReleaseRoot(context);
		return {
			rejected,
			error,
			body,
			received: server.requests.length,
			gateCalls,
			beginCalls,
			responseHeads,
			chunks,
			senderCalls,
			fakeLeaseCalls,
			forgedAuthorizeCalls,
			authorizePropertyReads,
			outcomes,
			probe,
			inflight,
			rootReacquired: true,
			auxiliaryTwinCalls,
			executionPropertyReads,
			forgedExecutionCalls,
			copiedTransportSymbols,
			modelStopReason,
			gatePurposes,
			alternateJournalState: alternateExecution?.journalState,
			verifiedReacquireRejected,
			journalStateAfter: context.execution.journalState,
		};
	} finally {
		Object.defineProperty(runtime, "authorize", { configurable: true, writable: true, value: originalAuthorize });
		Object.defineProperty(runtime, "currentExecution", {
			configurable: true,
			writable: true,
			value: originalCurrentExecution,
		});
		controller.abort();
		hold.resolve();
		server.stop();
	}
}

const result = await withReadyRoot(async context => ({
	scenario,
	journalStateBefore: context.execution.journalState,
	...(await dispatchRegression(context)),
}));
console.log(JSON.stringify(result));
