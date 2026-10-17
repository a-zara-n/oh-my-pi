import "../../../../scripts/audit-library-bootstrap";
import * as path from "node:path";
import { afterEach, describe, expect, test, vi } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as ai from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-ai";
import type { Api } from "@oh-my-pi/pi-utils/model-data";
import { Agent, type AgentEvent } from "@oh-my-pi/pi-agent-core";
import type { CustomMessage } from "@oh-my-pi/pi-agent-core";
import { runWithModelRequestExecution } from "@oh-my-pi/pi-ai/model-request-execution";
import { createAgentSession } from "../../src/sdk";
import * as sdkModule from "../../src/sdk";
import { Settings } from "../../src/config/settings";
import { ModelRegistry } from "../../src/config/model-registry";
import { startMemoryStartupTask } from "../../src/memories";
import { hindsightBackend } from "../../src/hindsight/backend";
import { HindsightSessionState } from "../../src/hindsight/state";
import * as mnemopiState from "../../src/mnemopi/state";
import { MnemopiSessionState, setMnemopiSessionState } from "../../src/mnemopi/state";
import { loadMnemopiConfig } from "../../src/mnemopi/config";
import { mnemopiBackend } from "../../src/mnemopi/backend";
import { startSharpshooterScheduler } from "../../src/sharpshooter/scheduler";
import { maybeStartSharpshooterExtraction } from "../../src/sharpshooter/extract";
import { ChainJudge } from "../../src/judgment";
import {
	createAgentSession as legacyShimCreateAgentSession,
	DefaultResourceLoader,
} from "../../src/extensibility/legacy-pi-coding-agent-shim";
import type { AgentSession } from "../../src/session/agent-session";
import { trackAgentSessionOuterWork } from "../../src/session/internal/agent-session-outer-work";
import { journalOuterWorkFromBinding } from "../../src/session/internal/outer-work";
import { childModelRequestRootOf } from "../../src/session/model-request-context";
import { resolveModelRequestRootSource } from "../../src/session/model-request-context";
import * as computerSupervisor from "../../src/tools/computer/supervisor";
import * as memoryBackendResolve from "../../src/memory-backend/resolve";
import type { MemoryBackend } from "../../src/memory-backend/types";
import {
	EXTENSION_HANDLER_TIMEOUT_MS,
	testSetExtensionHandlerTimeoutMs,
} from "../../src/extensibility/extensions/runner";
import { tinyModelClient } from "../../src/tiny/title-client";
import { ExtensionToolWrapper } from "../../src/extensibility/extensions/wrapper";
import { Type } from "../../src/extensibility/legacy-typebox";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { SessionManager } from "../../src/session/session-manager";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { tryAcquireSessionLease } from "@oh-my-pi/pi-utils/model-request-journal-composition";
import { R11JournalFixture } from "../../../utils/test/fixtures/model-request-journal-r11";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import {
	expectBindingAcceptsOuterWork,
	closedSessionIds,
	openManagedAgentHarness,
	withManagedExecution,
} from "./journal-outer-work-managed-harness";

const mac = process.platform === "darwin" ? describe : describe.skip;

const LOCAL_JUDGE = getBundledModel("local", "qwen2.5-1.5b");
const ONLINE_JUDGE = getBundledModel("anthropic", "claude-sonnet-4-6");

function makeJudgeRegistry(
	models: Model<Api>[],
	keys: Record<string, string> = {},
): { registry: ModelRegistry; authStorage: ReturnType<typeof createInMemoryAuthStorage> } {
	const authStorage = createInMemoryAuthStorage();
	for (const provider in keys) authStorage.keys.setRuntime(provider, keys[provider]!);
	const registry = new ModelRegistry(authStorage, "/nonexistent/journal-outer-work-judge-models.yml");
	vi.spyOn(registry, "getAvailable").mockReturnValue(models);
	return { registry, authStorage };
}

function mnemopiOuterWorkSettings(directory: string): Settings {
	return Settings.isolated({
		"compaction.enabled": false,
		"memory.backend": "mnemopi",
		"mnemopi.llmMode": "none",
		"mnemopi.scoping": "global",
		"mnemopi.bank": "default",
		"mnemopi.dbPath": path.join(directory, "mnemopi-outer-work.db"),
		"mnemopi.noEmbeddings": true,
	});
}

/** Avoid real SQLite / dynamic import side effects after module-load spies resolve. */
/** Flatten an AggregateError chain into its leaf causes. */
function leafCauses(error: unknown): unknown[] {
	const flattened: unknown[] = [];
	const collect = (cause: unknown): void => {
		if (cause instanceof AggregateError) {
			for (const inner of cause.errors) collect(inner);
			return;
		}
		flattened.push(cause);
	};
	collect(error);
	return flattened;
}

function stubMnemopiSessionStateConstructor(): void {
	// @ts-expect-error vi.spyOn constructor mock is untyped for class exports
	vi.spyOn(mnemopiState, "MnemopiSessionState").mockImplementation((options: {
		sessionId: string;
		config: ReturnType<typeof loadMnemopiConfig>;
		session: AgentSession;
	}) => {
		return {
			sessionId: options.sessionId,
			config: options.config,
			session: options.session,
			attachSessionListeners: vi.fn(),
			promoteEligibleWorkingMemory: vi.fn(),
			dispose: vi.fn(async () => {}),
		} as unknown as MnemopiSessionState;
	});
}

mac("journal outer work canonical source callers", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		testSetExtensionHandlerTimeoutMs(EXTENSION_HANDLER_TIMEOUT_MS);
	});

	test("S-01/AC-OL-01: createAgentSession holds binding startup work until settingsManager first await settles", async () => {
		const fixture = new R11JournalFixture();
		const settingsReady = Promise.withResolvers<Settings>();
		try {
			// The manager owns the root session file before the cell attaches, so the
			// SDK's root scan resolves this manager as the journal root (self-match).
			const sessionManager = SessionManager.create(fixture.directory, fixture.directory);
			const rootFile = sessionManager.getSessionFile();
			if (!rootFile) throw new Error("expected the journal root session file");
			const root = fixture.open(rootFile);
			await fixture.withBinding(root, async binding => {
				const authStorage = createInMemoryAuthStorage();
				const settings = Settings.isolated({ "compaction.enabled": false, "memory.enabled": false });
				const startup = createAgentSession({
					modelRequestJournalLeaseBinding: binding,
					authStorage,
					sessionManager,
					settingsManager: settingsReady.promise,
					modelRegistry: new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true }),
					disableExtensionDiscovery: true,
					bindProcessState: false,
					cwd: fixture.directory,
					agentDir: fixture.directory,
				});
				await Promise.resolve();
				expectBindingAcceptsOuterWork(binding);
				settingsReady.resolve(settings);
				const { session } = await startup;
				await session.dispose();
				await sessionManager.close();
				authStorage.close();
			});
		} finally {
			settingsReady.resolve(Settings.isolated());
			await fixture.close();
		}
	});
	test("S-02/AC-OL-02: message_update queue drain via AgentSession agent event entry", async () => {
		const fixture = new R11JournalFixture();
		try {
			const root = fixture.open();
			await fixture.withBinding(root, async binding => {
				const principal = await fixture.ready(binding, root);
				const harness = await openManagedAgentHarness(principal, binding);
				const releaseFirst = Promise.withResolvers<void>();
				const secondDone = Promise.withResolvers<void>();
				const order: string[] = [];
				harness.api.on("message_update", async event => {
					if (event.assistantMessageEvent.type !== "text_delta") return;
					const delta = event.assistantMessageEvent.delta;
					order.push(`start:${delta}`);
					if (delta === "A") await releaseFirst.promise;
					order.push(`end:${delta}`);
					if (delta === "B") secondDone.resolve();
				});
				await withManagedExecution(principal.execution, async () => {
					harness.emitMessageUpdate("A");
					harness.emitMessageUpdate("B");
					releaseFirst.resolve();
					await secondDone.promise;
				});
				expect(order).toEqual(["start:A", "end:A", "start:B", "end:B"]);
				await harness.dispose();
			});
		} finally {
			await fixture.close();
		}
	});

	test("S-02/AC-OL-02: pending event and flush retain the session owner lease until completion", async () => {
		const fixture = new R11JournalFixture();
		try {
			const root = fixture.open();
			await fixture.withBinding(root, async binding => {
				const principal = await fixture.ready(binding, root);
				const harness = await openManagedAgentHarness(principal, binding);
				const gate = Promise.withResolvers<void>();
				harness.api.on("message_update", async event => {
					if (event.assistantMessageEvent.type === "text_delta" && event.assistantMessageEvent.delta === "lease") {
						await gate.promise;
					}
				});
				await withManagedExecution(principal.execution, async () => {
					harness.emitMessageUpdate("lease");
					await Bun.sleep(5);
					// While the event dispatch outer work is held, another owner cannot take
					// the session file exclusive lease: the retention point is the real lock,
					// not a pending binding promise.
					const duringPending = tryAcquireSessionLease(root.getSessionId());
					expect(duringPending).toBeNull();
					gate.resolve();
					await Bun.sleep(10);
				});
				await harness.dispose();
			});
			// After completion — every outer work settled and the binding closed — the
			// exclusive lease is acquirable again by a new owner.
			const afterCompletion = tryAcquireSessionLease(root.getSessionId());
			expect(afterCompletion).not.toBeNull();
			afterCompletion?.release();
		} finally {
			await fixture.close();
		}
	});


	test("S-03/AC-OL-02: sendCustomMessage detached extension emit holds binding until dispatch settles", async () => {
		const fixture = new R11JournalFixture();
		try {
			const root = fixture.open();
			await fixture.withBinding(root, async binding => {
				const principal = await fixture.ready(binding, root);
				const harness = await openManagedAgentHarness(principal, binding);
				const gate = Promise.withResolvers<void>();
				let detachedDone = false;
				harness.api.on("message_start", async () => {
					await gate.promise;
					detachedDone = true;
				});
				const message: CustomMessage = {
					role: "custom",
					customType: "outer-work-probe",
					content: "idle",
					display: true,
					timestamp: Date.now(),
				};
				await withManagedExecution(principal.execution, async () => {
					const pending = harness.session.sendCustomMessage(message);
					await Promise.resolve();
					expectBindingAcceptsOuterWork(binding);
					gate.resolve();
					await pending;
				});
				expect(detachedDone).toBe(true);
				await harness.dispose();
			});
		} finally {
			await fixture.close();
		}
	});

	test("S-04a/AC-OL-02: message_end dispatch entry holds binding until extension and persistence settle", async () => {
		const fixture = new R11JournalFixture();
		try {
			const root = fixture.open();
			await fixture.withBinding(root, async binding => {
				const principal = await fixture.ready(binding, root);
				const harness = await openManagedAgentHarness(principal, binding);
				const gate = Promise.withResolvers<void>();
				harness.api.on("message_end", async () => {
					await gate.promise;
				});
				await withManagedExecution(principal.execution, async () => {
					const pending = harness.agent.emitExternalEvent({
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "persist-probe" }],
							api: "mock",
							provider: "mock",
							model: "mock",
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "stop",
							timestamp: Date.now(),
						},
					});
					await Promise.resolve();
					expectBindingAcceptsOuterWork(binding);
					gate.resolve();
					await pending;
				});
				await harness.dispose();
			});
		} finally {
			await fixture.close();
		}
	});

	test("S-04b/AC-OL-02: message_end extension tail via agent emitExternalEvent entry", async () => {
		const fixture = new R11JournalFixture();
		try {
			const root = fixture.open();
			await fixture.withBinding(root, async binding => {
				const principal = await fixture.ready(binding, root);
				const harness = await openManagedAgentHarness(principal, binding);
				const gate = Promise.withResolvers<void>();
				harness.api.on("message_end", async () => {
					await gate.promise;
				});
				await withManagedExecution(principal.execution, async () => {
					harness.emitMessageEnd();
					await Promise.resolve();
					expectBindingAcceptsOuterWork(binding);
					gate.resolve();
					await Bun.sleep(0);
				});
				await harness.dispose();
			});
		} finally {
			await fixture.close();
		}
	});

	test("S-04c/AC-OL-02: sendCustomMessage admitSubmission path holds binding until submission settles", async () => {
		const fixture = new R11JournalFixture();
		try {
			const root = fixture.open();
			await fixture.withBinding(root, async binding => {
				const principal = await fixture.ready(binding, root);
				const harness = await openManagedAgentHarness(principal, binding);
				const gate = Promise.withResolvers<void>();
				harness.api.on("message_end", async () => {
					await gate.promise;
				});
				const message: CustomMessage = {
					role: "custom",
					customType: "submission-probe",
					content: "x",
					display: true,
					timestamp: Date.now(),
				};
				await withManagedExecution(principal.execution, async () => {
					const pending = harness.session.sendCustomMessage(message);
					expectBindingAcceptsOuterWork(binding);
					gate.resolve();
					await pending;
				});
				await harness.dispose();
			});
		} finally {
			await fixture.close();
		}
	});

	test("S-06/AC-OL-13: runAutolearnCapture entry holds binding until capture callback settles", async () => {
		const fixture = new R11JournalFixture();
		try {
			const root = fixture.open();
			await fixture.withBinding(root, async binding => {
				const principal = await fixture.ready(binding, root);
				const harness = await openManagedAgentHarness(principal, binding);
				const gate = Promise.withResolvers<void>();
				await withManagedExecution(principal.execution, async () => {
					const pending = harness.session.runAutolearnCapture(async signal => {
						await gate.promise;
						expect(signal.aborted).toBe(false);
					});
					expectBindingAcceptsOuterWork(binding);
					gate.resolve();
					await pending;
				});
				await harness.dispose();
			});
		} finally {
			await fixture.close();
		}
	});

	test("S-07/AC-OL-13: startMemoryStartupTask entry joins void startup pipeline", async () => {
		const fixture = new R11JournalFixture();
		try {
			const root = fixture.open(path.join(fixture.directory, "mem-start.jsonl"));
			await fixture.withBinding(root, async binding => {
				const principal = await fixture.ready(binding, root);
				const harness = await openManagedAgentHarness(principal, binding);
				const settings = Settings.isolated({
					"compaction.enabled": false,
					"memory.enabled": true,
				});
				const registry = new ModelRegistry(harness.authStorage, undefined, { ignoreLocalModelConfig: true });
				await withManagedExecution(principal.execution, async () => {
					startMemoryStartupTask({
						session: harness.session,
						settings,
						modelRegistry: registry,
						agentDir: fixture.directory,
						taskDepth: 0,
					});
					await harness.session.settleMemoryBackend();
				});
				await harness.dispose();
			});
		} finally {
			await fixture.close();
		}
	});

	test("S-07/AC-OL-13: void memory backend start still joins detached startup via trackAgentSessionOuterWork", async () => {
		const fixture = new R11JournalFixture();
		try {
			const root = fixture.open();
			await fixture.withBinding(root, async binding => {
				const principal = await fixture.ready(binding, root);
				const harness = await openManagedAgentHarness(principal, binding);
				const inner = Promise.withResolvers<void>();
				const probeBackend: MemoryBackend = {
					id: "local",
					start: () => {
						trackAgentSessionOuterWork(harness.session, inner.promise);
					},
					buildDeveloperInstructions: async () => undefined,
					clear: async () => {},
					enqueue: async () => {},
				};
				const resolveSpy = vi.spyOn(memoryBackendResolve, "resolveMemoryBackend").mockResolvedValue(probeBackend);
				await withManagedExecution(principal.execution, async () => {
					const pending = harness.session.applyMemoryBackend();
					await Promise.resolve();
					expectBindingAcceptsOuterWork(binding);
					inner.resolve();
					await pending;
				});
				resolveSpy.mockRestore();
				await harness.dispose();
			});
		} finally {
			await fixture.close();
		}
	});

	test("S-07/AC-OL-13: applyMemoryBackend settings transition entry", async () => {
		const fixture = new R11JournalFixture();
		try {
			const root = fixture.open();
			await fixture.withBinding(root, async binding => {
				const principal = await fixture.ready(binding, root);
				const harness = await openManagedAgentHarness(principal, binding);
				await withManagedExecution(principal.execution, async () => {
					const pending = harness.session.applyMemoryBackend();
					expectBindingAcceptsOuterWork(binding);
					await pending;
				});
				await harness.dispose();
			});
		} finally {
			await fixture.close();
		}
	});

	test("S-07b/AC-OL-13: hindsightBackend.start tracks mental-model bootstrap on session handle", async () => {
		const fixture = new R11JournalFixture();
		const mentalModelGate = Promise.withResolvers<void>();
		try {
			const root = fixture.open();
			await fixture.withBinding(root, async binding => {
				const principal = await fixture.ready(binding, root);
				const harness = await openManagedAgentHarness(principal, binding);
				const settings = Settings.isolated({
					"compaction.enabled": false,
					"memory.backend": "hindsight",
					"hindsight.apiUrl": "http://127.0.0.1:1",
					"hindsight.mentalModelsEnabled": true,
				});
				vi.spyOn(HindsightSessionState.prototype, "runMentalModelLoad").mockImplementation(async () => {
					await mentalModelGate.promise;
				});
				await withManagedExecution(principal.execution, async () => {
					await hindsightBackend.start({
						session: harness.session,
						settings,
						modelRegistry: harness.session.modelRegistry,
						agentDir: fixture.directory,
						taskDepth: 0,
					});
					await Promise.resolve();
					expectBindingAcceptsOuterWork(binding);
					mentalModelGate.resolve();
					const state = harness.session.getHindsightSessionState();
					if (state?.mentalModelsLoadPromise) await state.mentalModelsLoadPromise;
				});
				await harness.dispose();
			});
		} finally {
			mentalModelGate.resolve();
			await fixture.close();
		}
	});

	test("S-07c/AC-OL-14: session.dispose joins detached Mnemopi consolidate on same handle", async () => {
		const fixture = new R11JournalFixture();
		try {
			const root = fixture.open();
			await fixture.withBinding(root, async binding => {
				const principal = await fixture.ready(binding, root);
				const harness = await openManagedAgentHarness(principal, binding);
				const hold = Promise.withResolvers<void>();
				const settings = Settings.isolated({ "memory.backend": "mnemopi", "compaction.enabled": false });
				const config = loadMnemopiConfig(settings, fixture.directory);
				const state = {
					sessionId: harness.session.sessionId,
					config,
					session: harness.session,
					consolidate: vi.fn(async () => {
						await hold.promise;
					}),
					dispose: vi.fn(async () => {}),
				} as unknown as MnemopiSessionState;
				setMnemopiSessionState(harness.session, state);
				await withManagedExecution(principal.execution, async () => {
					const pending = harness.session.dispose({ mnemopiConsolidateTimeoutMs: 1 });
					await Bun.sleep(5);
					expectBindingAcceptsOuterWork(binding);
					hold.resolve();
					await pending;
				});
				await harness.dispose();
			});
		} finally {
			await fixture.close();
		}
	});

	test("S-07c/AC-OL-13: mnemopiBackend.start holds binding until parallel module loaders settle", async () => {
		const fixture = new R11JournalFixture();
		const rootHeld = Promise.withResolvers<void>();
		try {
			const root = fixture.open();
			await fixture.withBinding(root, async binding => {
				const principal = await fixture.ready(binding, root);
				const harness = await openManagedAgentHarness(principal, binding);
				const settings = mnemopiOuterWorkSettings(fixture.directory);
				let modulesEntered = false;
				vi.spyOn(mnemopiState, "loadMnemopiModules").mockImplementation(async () => {
					modulesEntered = true;
					const settled = await Promise.allSettled([rootHeld.promise, Promise.resolve()]);
					const failures = settled
						.filter((result): result is PromiseRejectedResult => result.status === "rejected")
						.map(result => result.reason);
					if (failures.length > 0) throw new AggregateError(failures, "Mnemopi module load failed");
				});
				stubMnemopiSessionStateConstructor();
				await withManagedExecution(principal.execution, async () => {
					const pending = mnemopiBackend.start({
						session: harness.session,
						settings,
						modelRegistry: harness.session.modelRegistry,
						agentDir: fixture.directory,
						taskDepth: 0,
					});
					const enteredBy = Date.now() + 2_000;
					while (!modulesEntered && Date.now() < enteredBy) await Bun.sleep(1);
					expect(modulesEntered).toBe(true);
					expectBindingAcceptsOuterWork(binding);
					expect(closedSessionIds(principal.cell)).toEqual([]);
					rootHeld.resolve();
					await pending;
				});
				await harness.dispose();
			});
		} finally {
			rootHeld.resolve();
			await fixture.close();
		}
	});

	test("S-07c/AC-OL-14: mnemopiBackend.start keeps binding until allSettled finishes when one loader rejects", async () => {
		const fixture = new R11JournalFixture();
		const rootHeld = Promise.withResolvers<void>();
		try {
			const root = fixture.open();
			await fixture.withBinding(root, async binding => {
				const principal = await fixture.ready(binding, root);
				const harness = await openManagedAgentHarness(principal, binding);
				const settings = mnemopiOuterWorkSettings(fixture.directory);
				let modulesEntered = false;
				vi.spyOn(mnemopiState, "loadMnemopiModules").mockImplementation(async () => {
					modulesEntered = true;
					const settled = await Promise.allSettled([
						rootHeld.promise,
						Promise.reject(new Error("core load failed")),
					]);
					const failures = settled
						.filter((result): result is PromiseRejectedResult => result.status === "rejected")
						.map(result => result.reason);
					if (failures.length > 0) throw new AggregateError(failures, "Mnemopi module load failed");
				});
				await withManagedExecution(principal.execution, async () => {
					const pending = mnemopiBackend.start({
						session: harness.session,
						settings,
						modelRegistry: harness.session.modelRegistry,
						agentDir: fixture.directory,
						taskDepth: 0,
					});
					const enteredBy = Date.now() + 2_000;
					while (!modulesEntered && Date.now() < enteredBy) await Bun.sleep(1);
					expect(modulesEntered).toBe(true);
					expectBindingAcceptsOuterWork(binding);
					expect(closedSessionIds(principal.cell)).toEqual([]);
					rootHeld.resolve();
					await pending;
				});
				await harness.dispose();
			});
		} finally {
			rootHeld.resolve();
			await fixture.close();
		}
	});

	test("S-08/AC-OL-13: sharpshooter scheduler tick and extraction entries", async () => {
		const fixture = new R11JournalFixture();
		try {
			const root = fixture.open();
			await fixture.withBinding(root, async binding => {
				const principal = await fixture.ready(binding, root);
				const harness = await openManagedAgentHarness(principal, binding);
				const settings = Settings.isolated({ "compaction.enabled": false, "memory.backend": "sharpshooter" });
				await withManagedExecution(principal.execution, async () => {
					const stop = startSharpshooterScheduler({
						agentDir: fixture.directory,
						cwd: fixture.directory,
						settings,
						modelRegistry: harness.session.modelRegistry,
						sessionId: harness.session.sessionId,
					});
					stop();
					maybeStartSharpshooterExtraction({
						session: harness.session,
						settings,
						modelRegistry: harness.session.modelRegistry,
						agentDir: fixture.directory,
						message: {
							role: "user",
							content: "We decided to use Postgres for the ledger schema going forward.",
							timestamp: Date.now(),
						},
					});
					await Bun.sleep(0);
				});
				await harness.dispose();
			});
		} finally {
			await fixture.close();
		}
	});

	test("S-09/AC-OL-13: legacy shim createAgentSession begins before loader.reload await", async () => {
		const fixture = new R11JournalFixture();
		const reloadGate = Promise.withResolvers<void>();
		try {
			// The shim's child session resolves the journal root through the agent
			// registry; register a live root manager holder for the scan to find.
			const rootManager = SessionManager.create(fixture.directory, fixture.directory);
			const rootFile = rootManager.getSessionFile();
			if (!rootFile) throw new Error("expected the journal root session file");
			const root = fixture.open(rootFile);
			const registry = AgentRegistry.global();
			const holder = registry.register({
				id: "s09-root-holder",
				displayName: "S-09 root holder",
				kind: "main",
				session: { sessionManager: rootManager } as unknown as AgentSession,
			});
			try {
			await fixture.withBinding(root, async binding => {
				const principal = await fixture.ready(binding, root);
				const loader = new DefaultResourceLoader({ cwd: fixture.directory, agentDir: fixture.directory });
				const originalReload = loader.reload.bind(loader);
				loader.reload = async () => {
					await reloadGate.promise;
					return originalReload();
				};
				const authStorage = createInMemoryAuthStorage();
				await runWithModelRequestExecution(principal.execution, async () => {
					const pending = legacyShimCreateAgentSession({
						modelRequestRoot: childModelRequestRootOf(principal.execution),
						modelRequestJournalLeaseBinding: binding,
						resourceLoader: loader,
						authStorage,
						disableExtensionDiscovery: true,
						bindProcessState: false,
						cwd: fixture.directory,
						agentDir: fixture.directory,
						settings: Settings.isolated({ "compaction.enabled": false, "memory.enabled": false }),
					});
					await Promise.resolve();
					expectBindingAcceptsOuterWork(binding);
					reloadGate.resolve();
					const { session } = await pending;
					await session.dispose();
				});
					authStorage.close();
			});
			} finally {
				registry.unregister(holder.id, holder);
				await rootManager.close();
			}
		} finally {
			reloadGate.resolve();
			await fixture.close();
		}
	});

	test("S-10/AC-OL-13: ExtensionRunner onToolRegistered flush reject fails tool_call handler outer work", async () => {
		const fixture = new R11JournalFixture();
		let operation: Promise<void> | undefined;
		try {
			const root = fixture.open();
			operation = fixture.withBinding(root, async binding => {
				const principal = await fixture.ready(binding, root);
				const harness = await openManagedAgentHarness(principal, binding);
				harness.runner.onToolRegistered(async () => {
					throw new Error("flush reject");
				});
				harness.api.on("tool_call", () => {
					harness.api.registerTool({
						name: "late_registered",
						label: "late",
						description: "late",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
					});
				});
				const tool: AgentTool = {
					name: "probe",
					label: "probe",
					description: "probe",
					parameters: Type.Object({}),
					approval: "read",
					execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
				};
				const wrapped = new ExtensionToolWrapper(tool, harness.runner);
				await withManagedExecution(principal.execution, async () => {
					await expect(wrapped.execute("id", {})).rejects.toThrow("flush reject");
				});
				await harness.dispose();
				void operation?.catch(() => {});
				const received = await operation?.then(
					() => undefined,
					error => error,
				);
				// The flush failure is accounted: the binding drain surfaces it.
				expect(
					leafCauses(received).some(
						cause => cause instanceof Error && cause.message === "flush reject",
					),
				).toBe(true);
			});
		} finally {
			await fixture.close();
		}
	});

	test("S-10/AC-OL-13: ExtensionRunner tool_call timeout keeps handler outer work for late tool registration", async () => {
		const fixture = new R11JournalFixture();
		testSetExtensionHandlerTimeoutMs(25);
		try {
			const root = fixture.open();
			await fixture.withBinding(root, async binding => {
				const principal = await fixture.ready(binding, root);
				const harness = await openManagedAgentHarness(principal, binding);
				harness.runner.onToolRegistered(async () => {
					throw new Error("flush reject");
				});
				const tool: AgentTool = {
					name: "probe",
					label: "probe",
					description: "probe",
					parameters: Type.Object({}),
					approval: "read",
					execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
				};
				harness.api.on("tool_call", async () => {
					// Outlives the 25ms handler budget so late tool registration stays on the raw handler future.
					await Bun.sleep(50);
				});
				const wrapped = new ExtensionToolWrapper(tool, harness.runner);
				await withManagedExecution(principal.execution, async () => {
					const pending = wrapped.execute("id", {});
					const settled = expect(pending).rejects.toThrow(/timed out after 25ms/);
					await Bun.sleep(30);
					harness.api.registerTool({
						name: "late_registered",
						label: "late",
						description: "late",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
					});
					await settled;
					await Bun.sleep(0);
				});
				await harness.dispose();
			});
		} finally {
			testSetExtensionHandlerTimeoutMs(EXTENSION_HANDLER_TIMEOUT_MS);
			await fixture.close();
		}
	});

	test("S-12/AC-OL-14: agent_end allSettled waits for processAgentEvent when computerControlRevocation rejects", async () => {
		const fixture = new R11JournalFixture();
		let operation: Promise<void> | undefined;
		try {
			const root = fixture.open();
			operation = fixture.withBinding(root, async binding => {
				const principal = await fixture.ready(binding, root);
				const harness = await openManagedAgentHarness(principal, binding);
				const gate = Promise.withResolvers<void>();
				let maintenanceDone = false;
				harness.api.on("agent_end", async () => {
					await gate.promise;
					maintenanceDone = true;
				});
				vi.spyOn(computerSupervisor, "revokeComputerControlForOwner").mockRejectedValueOnce(
					new Error("revoke failed"),
				);
				await withManagedExecution(principal.execution, async () => {
					// emitExternalEvent is fire-and-forget in agent-core; the maintenance failure
					// surfaces consumer-visibly as a session notice after the allSettled drain.
					const notices: string[] = [];
					const noticeSpy = vi.spyOn(harness.session, "emitNotice").mockImplementation((_level, message) => {
						notices.push(message);
					});
					try {
						harness.agent.emitExternalEvent({ type: "agent_end", messages: [] });
						await Promise.resolve();
						expect(maintenanceDone).toBe(false);
						expectBindingAcceptsOuterWork(binding);
						gate.resolve();
						const deadline = Date.now() + 2_000;
						while (notices.length === 0 && Date.now() < deadline) await Bun.sleep(1);
						expect(notices.some(message => message.includes("Post-turn maintenance failed: revoke failed"))).toBe(
							true,
						);
						expect(maintenanceDone).toBe(true);
					} finally {
						noticeSpy.mockRestore();
					}
				});
				await harness.dispose();
				void operation?.catch(() => {});
				const received = await operation?.then(
					() => undefined,
					error => error,
				);
				// The maintenance failure is accounted: the binding drain surfaces it.
				expect(
					leafCauses(received).some(
						cause => cause instanceof Error && cause.message === "revoke failed",
					),
				).toBe(true);
			});
		} finally {
			vi.restoreAllMocks();
			await fixture.close();
		}
	});

	test("AC-OL-08/S-01: createAgentSession startup outer work ends before binding accepts new work after dispose", async () => {
		const fixture = new R11JournalFixture();
		const settingsReady = Promise.withResolvers<Settings>();
		try {
			// Manager owns the root file before the cell attaches (root scan self-match).
			const sessionManager = SessionManager.create(fixture.directory, fixture.directory);
			const rootFile = sessionManager.getSessionFile();
			if (!rootFile) throw new Error("expected the journal root session file");
			const root = fixture.open(rootFile);
			await fixture.withBinding(root, async binding => {
				const authStorage = createInMemoryAuthStorage();
				const settings = Settings.isolated({ "compaction.enabled": false, "memory.enabled": false });
				const startup = createAgentSession({
					modelRequestJournalLeaseBinding: binding,
					authStorage,
					sessionManager,
					settingsManager: settingsReady.promise,
					modelRegistry: new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true }),
					disableExtensionDiscovery: true,
					bindProcessState: false,
					cwd: fixture.directory,
					agentDir: fixture.directory,
				});
				settingsReady.resolve(settings);
				const { session } = await startup;
				await session.dispose();
				expectBindingAcceptsOuterWork(binding);
				authStorage.close();
			});
		} finally {
			settingsReady.resolve(Settings.isolated());
			await fixture.close();
		}
	});

	test("S-12/AC-OL-14: agent_end dispatch entry holds binding until maintenance settles", async () => {
		const fixture = new R11JournalFixture();
		try {
			const root = fixture.open();
			await fixture.withBinding(root, async binding => {
				const principal = await fixture.ready(binding, root);
				const harness = await openManagedAgentHarness(principal, binding);
				const gate = Promise.withResolvers<void>();
				harness.api.on("session_stop", async () => {
					await gate.promise;
				});
				await withManagedExecution(principal.execution, async () => {
					const event: AgentEvent = { type: "agent_end", messages: [] };
					const pending = harness.agent.emitExternalEvent(event);
					await Promise.resolve();
					expectBindingAcceptsOuterWork(binding);
					gate.resolve();
					await pending;
				});
				await harness.dispose();
			});
		} finally {
			await fixture.close();
		}
	});

	test("S-12/AC-OL-14: checkCompaction continuation stays on agent_end outer-work scope", async () => {
		const fixture = new R11JournalFixture();
		try {
			const root = fixture.open();
			await fixture.withBinding(root, async binding => {
				const principal = await fixture.ready(binding, root);
				const harness = await openManagedAgentHarness(principal, binding, {
					settings: Settings.isolated({ "compaction.enabled": true, "memory.enabled": false }),
				});
				const gate = Promise.withResolvers<void>();
				harness.api.on("session_before_compact", async () => {
					await gate.promise;
				});
				await withManagedExecution(principal.execution, async () => {
					const assistant = {
						role: "assistant" as const,
						content: [{ type: "text" as const, text: "x".repeat(400_000) }],
						api: "mock",
						provider: "mock",
						model: "mock",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop" as const,
						timestamp: Date.now(),
					};
					const pending = harness.agent.emitExternalEvent({ type: "agent_end", messages: [assistant] });
					await Promise.resolve();
					expectBindingAcceptsOuterWork(binding);
					gate.resolve();
					await pending;
				});
				await harness.dispose();
			});
		} finally {
			await fixture.close();
		}
	});

	test("G-01/AC-OL-14: ChainJudge.withCandidate entry holds outer work through candidate run", async () => {
		const fixture = new R11JournalFixture();
		try {
			const root = fixture.open();
			await fixture.withBinding(root, async binding => {
				const principal = await fixture.ready(binding, root);
				const authStorage = createInMemoryAuthStorage();
				const settings = Settings.isolated({ "roles.judge": ["local/qwen2.5-1.5b"] });
				const registry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
				await withManagedExecution(principal.execution, async () => {
					const judge = new ChainJudge({ settings, registry, purpose: "outer-work-probe" });
					const answer = await judge.withCandidate(async () => ({ ok: true }));
					expect(answer).toEqual({ ok: true });
				});
				authStorage.close();
			});
		} finally {
			await fixture.close();
		}
	});

	test("G-01/AC-OL-14: ChainJudge.withCandidate recovers on fallback judge after first candidate fails", async () => {
		if (!LOCAL_JUDGE || !ONLINE_JUDGE) return;
		const fixture = new R11JournalFixture();
		try {
			const root = fixture.open();
			await fixture.withBinding(root, async binding => {
				const principal = await fixture.ready(binding, root);
				const settings = Settings.isolated({
					modelRoles: { judge: `${LOCAL_JUDGE.provider}/${LOCAL_JUDGE.id}` },
					"retry.fallbackChains": { judge: [`${ONLINE_JUDGE.provider}/${ONLINE_JUDGE.id}`] },
				});
				const { registry, authStorage } = makeJudgeRegistry([LOCAL_JUDGE, ONLINE_JUDGE], {
					[ONLINE_JUDGE.provider]: "key",
				});
				const kinds: string[] = [];
				vi.spyOn(tinyModelClient, "complete").mockRejectedValueOnce(new Error("local judge failed"));
				vi.spyOn(ai, "completeSimple").mockImplementation(async model => ({
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				}));
				await withManagedExecution(principal.execution, async () => {
					const judge = new ChainJudge({ settings, registry, purpose: "outer-work-probe" });
					const answer = await judge.withCandidate(async (candidate, kind) => {
						kinds.push(kind);
						if (kind === "online") return "recovered";
						await candidate.judge({
							state: "outer-work probe",
							questions: {
								bucket: {
									type: "choice",
									instructions: "Choose a bucket.",
									criteria: { trivial: "trivial", moderate: "moderate" },
								},
							},
						});
						return "local";
					});
					expect(answer).toBe("recovered");
					expect(kinds).toEqual(["local", "online"]);
				});
				authStorage.close();
			});
		} finally {
			vi.restoreAllMocks();
			await fixture.close();
		}
	});

	test("S-05/AC-OL-11: executor spawn outer work joins late createAgentSession dispose after abort", async () => {
		const fixture = new R11JournalFixture();
		const createGate = Promise.withResolvers<void>();
		const disposeSeen = Promise.withResolvers<void>();
		const createSpy = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			await createGate.promise;
			return {
				session: {
					dispose: async () => {
						disposeSeen.resolve();
					},
				},
				extensionsResult: { extensions: [], errors: [] },
			} as unknown as Awaited<ReturnType<typeof sdkModule.createAgentSession>>;
		});
		try {
			const root = fixture.open();
			await fixture.withBinding(root, async binding => {
				const principal = await fixture.ready(binding, root);
				const modelRequestRoot = childModelRequestRootOf(principal.execution);
				const spawnOuterWork = journalOuterWorkFromBinding(
					resolveModelRequestRootSource(modelRequestRoot, binding).modelRequestJournalLeaseBinding,
				);
				const sessionPromise = sdkModule.createAgentSession({
					modelRequestRoot,
					modelRequestJournalLeaseBinding: binding,
					disableExtensionDiscovery: true,
				});
				spawnOuterWork.trackDetached(sessionPromise);
				createGate.resolve();
				spawnOuterWork.trackDetached(
					sessionPromise.then(async created => {
						await created.session.dispose();
					}),
				);
				await spawnOuterWork.complete(new Error("aborted before session returned"));
				await disposeSeen.promise;
			});
		} finally {
			createSpy.mockRestore();
			createGate.resolve();
			await fixture.close();
		}
	});

	test("drain loop: late trackDetached during complete settles before endJournalWork", async () => {
		const fixture = new R11JournalFixture();
		try {
			const root = fixture.open();
			await fixture.withBinding(root, async binding => {
				const scope = journalOuterWorkFromBinding(binding);
				let nestedDone = false;
				const gate = Promise.withResolvers<void>();
				scope.trackDetached(
					gate.promise.then(() => {
						const inner = Promise.withResolvers<void>();
						scope.trackDetached(inner.promise.then(() => {
							nestedDone = true;
						}));
						inner.resolve();
					}),
				);
				gate.resolve();
				await scope.complete();
				expect(nestedDone).toBe(true);
			});
		} finally {
			await fixture.close();
		}
	});
});
