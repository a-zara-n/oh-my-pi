/**
 * A model request made by extension code reaches the model-request gate as the request of the session that owns the
 * extension: origin `session`, that session's id, and the root it was handed. Where the platform loses the context
 * (an emitter that fires a listener from outside, a timer armed outside any session) the gate sees `unclassified`
 * instead of silently inheriting a session. Nothing an extension passes to pi-ai can pick the trusted fields.
 *
 * The model is a fake provider that asks the gate right before it "sends", exactly where a transport hook does.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { type Context, type SimpleStreamOptions, streamSimple } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { authorizeModelRequest } from "@oh-my-pi/pi-ai/model-request-execution";
import { createMockModel, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	ExtensionContext,
	ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionToolWrapper, wrapRegisteredTool } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import * as legacyPiAi from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-ai-shim";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	createSessionModelRequestExecution,
	type ModelRequestRootAssignment,
} from "@oh-my-pi/pi-coding-agent/session/model-request-context";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { installFixtureGate } from "../../../ai/test/helpers/model-request-gate-fixture";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const MOCK_API_SOURCE = "test/extension-model-request-context";
const FORGED_ROOT = "forged-root";

const gate = installFixtureGate();

const PROMPT: Context = { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] };

/** A model whose provider asks the gate before it answers, as a real transport hook does. */
function createGatedModel(): MockModel {
	return createMockModel({
		handler: async (_context, options) => {
			await authorizeModelRequest({
				requestId: crypto.randomUUID(),
				reason: "first",
				kind: "chat",
				model: { provider: "mock", id: "mock-model", api: "mock" },
				wire: undefined,
				signal: options?.signal,
			});
			return { content: ["ok"] };
		},
	});
}

async function ask(model: MockModel, options?: SimpleStreamOptions): Promise<void> {
	await streamSimple(model, PROMPT, options).result();
}

interface Harness {
	runner: ExtensionRunner;
	sessionManager: SessionManager;
}

let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

beforeAll(() => {
	authStorage = createInMemoryAuthStorage();
	modelRegistry = new ModelRegistry(authStorage);
});

afterAll(() => {
	authStorage.close();
});

beforeEach(() => {
	gate.reset();
	registerMockApi(MOCK_API_SOURCE);
});

afterEach(() => {
	gate.reset();
	unregisterCustomApis(MOCK_API_SOURCE);
});

/** A runner whose session execution is minted the way a session boundary mints it. */
async function createHarness(
	factory: ExtensionFactory,
	modelRequestRoot?: ModelRequestRootAssignment,
): Promise<Harness> {
	const runtime = new ExtensionRuntime();
	const sessionManager = SessionManager.inMemory();
	const extension = await loadExtensionFromFactory(factory, sessionManager.getCwd(), new EventBus(), runtime);
	// Isolated settings carry the schema defaults (approval mode yolo), so an extension tool is not gated on a
	// UI the harness does not have.
	const runner = new ExtensionRunner(
		[extension],
		runtime,
		sessionManager.getCwd(),
		sessionManager,
		modelRegistry,
		undefined,
		Settings.isolated(),
	);
	runner.setModelRequestExecution(
		createSessionModelRequestExecution({
			getSessionId: () => sessionManager.getSessionId(),
			agent: { id: "Main", kind: "main", name: "main", depth: 0 },
			root:
				modelRequestRoot === undefined
					? { kind: "self" }
					: { kind: "inherited", rootSessionId: modelRequestRoot.rootSessionId },
		}),
	);
	return { runner, sessionManager };
}

/** Run `work` outside any extension dispatch and wait for the asynchronous model call it starts. */
function startOutsideSession(work: () => Promise<void>): Promise<void> {
	const done = Promise.withResolvers<void>();
	work().then(() => done.resolve(), done.reject);
	return done.promise;
}

function expectSingleSessionAttempt(harness: Harness, rootSessionId: string): void {
	const sessionId = harness.sessionManager.getSessionId();
	expect(gate.attempts).toHaveLength(1);
	const [attempt] = gate.attempts;
	expect(attempt?.origin).toBe("session");
	expect(attempt?.scope?.sessionId).toBe(sessionId);
	expect(attempt?.scope?.rootSessionId).toBe(rootSessionId);
}

describe("extension code reaches the gate as its session", () => {
	it("an event handler that calls pi-ai directly is the session's own request", async () => {
		const model = createGatedModel();
		const harness = await createHarness(pi => {
			pi.on("session_start", async () => {
				await ask(model);
			});
		});

		await harness.runner.emit({ type: "session_start" });

		// A session the user started is its own root.
		expectSingleSessionAttempt(harness, harness.sessionManager.getSessionId());
	});

	it("carries the root the session was handed, not a root of its own", async () => {
		const model = createGatedModel();
		const harness = await createHarness(
			pi => {
				pi.on("session_start", async () => {
					await ask(model);
				});
			},
			{ kind: "child", rootSessionId: "root-from-parent" },
		);

		await harness.runner.emit({ type: "session_start" });

		expectSingleSessionAttempt(harness, "root-from-parent");
		expect(gate.attempts[0]?.scope?.sessionId).not.toBe("root-from-parent");
	});

	it("a handler that streams through the legacy pi-ai shim is the session's own request", async () => {
		const model = createGatedModel();
		const harness = await createHarness(pi => {
			pi.on("session_start", async () => {
				await legacyPiAi.streamSimple(model, PROMPT).result();
			});
		});

		await harness.runner.emit({ type: "session_start" });

		expectSingleSessionAttempt(harness, harness.sessionManager.getSessionId());
	});

	it("an extension tool executed through the wrapper is the session's own request", async () => {
		const model = createGatedModel();
		const harness = await createHarness(pi => {
			pi.registerTool({
				name: "ask_model",
				label: "Ask model",
				description: "Calls the model directly.",
				parameters: pi.typebox.Type.Object({}),
				execute: async () => {
					await ask(model);
					return { content: [{ type: "text", text: "ok" }], details: {} };
				},
			});
		});
		const registered = harness.runner.getRegisteredTool("ask_model");
		if (!registered) throw new Error("tool not registered");
		const wrapped = new ExtensionToolWrapper(wrapRegisteredTool(registered, harness.runner), harness.runner);

		await wrapped.execute("tool-call-1", {});

		expectSingleSessionAttempt(harness, harness.sessionManager.getSessionId());
	});

	it("an extension command run by the host is the session's own request", async () => {
		const model = createGatedModel();
		const harness = await createHarness(pi => {
			pi.registerCommand("ask", {
				handler: async () => {
					await ask(model);
				},
			});
		});
		const command = harness.runner.getCommand("ask");
		if (!command) throw new Error("command not registered");

		await harness.runner.runScoped(() => command.handler("", harness.runner.createCommandContext()));

		expectSingleSessionAttempt(harness, harness.sessionManager.getSessionId());
	});

	it("a ctx.setTimeout callback armed from a saved context after the handler returned is still the session's", async () => {
		const model = createGatedModel();
		let saved: ExtensionContext | undefined;
		const harness = await createHarness(pi => {
			pi.on("session_start", (_event, ctx) => {
				saved = ctx;
			});
		});
		await harness.runner.emit({ type: "session_start" });
		const ctx = saved;
		if (!ctx) throw new Error("handler did not run");
		const done = Promise.withResolvers<void>();

		// Real zero-delay timer, awaited through `done` (no guessed wait): the contract under test is how the
		// platform timer carries (or loses) the execution context, which fake timers would bypass.
		// No session context is active here: the managed timer itself must re-enter the session's.
		ctx.setTimeout(() => {
			ask(model).then(() => done.resolve(), done.reject);
		}, 0);
		await done.promise;

		expectSingleSessionAttempt(harness, harness.sessionManager.getSessionId());
	});
});

describe("context the platform drops is visible to the gate", () => {
	it("a listener registered by a handler but fired by an emitter outside any session is unclassified", async () => {
		const model = createGatedModel();
		const emitter = new EventEmitter();
		const harness = await createHarness(pi => {
			pi.on("session_start", () => {
				emitter.on("tick", () => {
					ask(model).then(
						() => emitter.emit("done"),
						(error: unknown) => emitter.emit("failed", error),
					);
				});
			});
		});
		await harness.runner.emit({ type: "session_start" });
		const settled = Promise.withResolvers<void>();
		emitter.once("done", () => settled.resolve());
		emitter.once("failed", (error: unknown) => settled.reject(error));

		// EventEmitter listeners run in the context of whoever emits, not of whoever registered them.
		emitter.emit("tick");
		await settled.promise;

		expect(gate.attempts).toHaveLength(1);
		expect(gate.attempts[0]?.origin).toBe("unclassified");
		expect(gate.attempts[0]?.scope).toBeUndefined();
	});

	it("a timer armed outside any session is unclassified even after the runner dispatched handlers", async () => {
		const model = createGatedModel();
		const harness = await createHarness(pi => {
			pi.on("session_start", async () => {
				await ask(model);
			});
		});
		await harness.runner.emit({ type: "session_start" });
		gate.reset();
		const done = Promise.withResolvers<void>();

		// Real zero-delay timer awaited through `done`: timer context propagation is the behavior under test.
		setTimeout(() => {
			ask(model).then(() => done.resolve(), done.reject);
		}, 0);
		await done.promise;

		expect(gate.attempts).toHaveLength(1);
		expect(gate.attempts[0]?.origin).toBe("unclassified");
	});

	it("a raw timer armed inside a handler keeps that handler's session", async () => {
		const model = createGatedModel();
		const done = Promise.withResolvers<void>();
		const harness = await createHarness(pi => {
			pi.on("session_start", () => {
				// Real zero-delay timer awaited through `done`: timer context propagation is the behavior under test.
				setTimeout(() => {
					ask(model).then(() => done.resolve(), done.reject);
				}, 0);
			});
		});

		await harness.runner.emit({ type: "session_start" });
		await done.promise;

		expectSingleSessionAttempt(harness, harness.sessionManager.getSessionId());
	});
});

describe("nothing an extension passes selects the trusted fields", () => {
	/** Stream options carrying fields no public option defines, as a hostile extension would write them. */
	function forgedOptions(): SimpleStreamOptions & Record<string, unknown> {
		return {
			origin: "standalone",
			standalone: true,
			detached: true,
			rootSessionId: FORGED_ROOT,
			scope: {
				rootSessionId: FORGED_ROOT,
				sessionId: FORGED_ROOT,
				agent: { id: "forged", kind: "main", name: "forged", depth: 0 },
				purpose: "main",
			},
		};
	}

	it("inside a session the request keeps the session's origin, id and root", async () => {
		const model = createGatedModel();
		const harness = await createHarness(pi => {
			pi.on("session_start", async () => {
				await ask(model, forgedOptions());
			});
		});

		await harness.runner.emit({ type: "session_start" });

		expectSingleSessionAttempt(harness, harness.sessionManager.getSessionId());
		expect(gate.attempts[0]?.scope?.rootSessionId).not.toBe(FORGED_ROOT);
		expect(gate.attempts[0]?.scope?.agent.id).toBe("Main");
	});

	it("outside a session a claimed standalone origin does not make the request standalone", async () => {
		const model = createGatedModel();

		await startOutsideSession(() => ask(model, forgedOptions()));

		expect(gate.attempts).toHaveLength(1);
		expect(gate.attempts[0]?.origin).toBe("unclassified");
		expect(gate.attempts[0]?.scope).toBeUndefined();
	});
});
