/**
 * Runs in its own process (a gate registration cannot be undone, so process-wide behavior needs a fresh one).
 * Prints one JSON object describing what a consumer of the public API observed.
 *
 * Scenarios (argv[2]):
 *  - unregistered: a request through the real `completeSimple` entry with no gate registered reaches the transport.
 *  - shared-latch: a second copy of the runtime module cannot hold a different gate than the first.
 *  - managed-none/pass/deny: unconnected managed contexts must stop at real fetch and custom stream controls.
 */
import { completeSimple, registerCustomApi } from "@oh-my-pi/pi-ai";
import {
	createModelRequestSessionExecution,
	deriveModelRequestExecution,
	runWithModelRequestExecution,
} from "@oh-my-pi/pi-ai/model-request-execution";
import { isModelRequestDenied } from "@oh-my-pi/pi-ai/error";
import {
	getModelRequestGateInfo,
	type ModelRequestDecision,
	type ModelRequestGate,
	registerModelRequestGate,
} from "@oh-my-pi/pi-ai/model-request-gate";
import type { Api, AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { stream } from "@oh-my-pi/pi-ai/stream";
import { authorizeUninstrumentedAttempt, gatedSend, gateFetch } from "@oh-my-pi/pi-ai/utils/model-request-fetch";
import type { ModelRequestJournalLeaseBinding } from "@oh-my-pi/pi-utils/model-request-journal-authority";

const API = "model-request-gate-process-fixture" as Api;

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: API,
		provider: "fixture",
		model: "fixture-1",
		timestamp: 1,
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

const fixtureModel = {
	id: "fixture-1",
	name: "Fixture",
	api: API,
	provider: "fixture",
	contextWindow: 1000,
	maxTokens: 100,
} as Model<Api>;

const context: Context = { systemPrompt: [], messages: [{ role: "user", content: "hi", timestamp: 1 }] };

/** A custom provider's transport callback: no manual authorization may mask an entry-point fast-path gap. */
function registerFakeTransport(counter: { wire: number }): void {
	registerCustomApi(API, () => {
		counter.wire += 1;
		const events = new AssistantMessageEventStream();
		const message = assistant("ok");
		events.push({ type: "start", partial: message });
		events.push({ type: "done", reason: "stop", message });
		return events;
	});
}

const pass: ModelRequestGate = { authorize: async (): Promise<ModelRequestDecision> => ({ type: "pass" }) };

async function unregistered(): Promise<object> {
	const counter = { wire: 0 };
	registerFakeTransport(counter);
	const message = await completeSimple(fixtureModel, context, { apiKey: "unused" });
	return {
		wire: counter.wire,
		stopReason: message.stopReason,
		registered: getModelRequestGateInfo().registered,
	};
}

type RegisterGate = (owner: string, gate: ModelRequestGate) => void;

const RUNTIME_MODULE = new URL("../../src/model-request-runtime.ts", import.meta.url).href;

/**
 * Evaluate the runtime module afresh under `tag`, standing for one more copy of pi-ai in the process.
 * A computed specifier is required: a distinct query string is what makes the runtime evaluate the module again.
 */
async function loadRegisterFromCopy(tag: string): Promise<RegisterGate> {
	const loaded: unknown = await import(`${RUNTIME_MODULE}?copy=${tag}`);
	if (typeof loaded !== "object" || loaded === null || !("getModelRequestRuntime" in loaded)) {
		throw new Error("runtime copy does not export getModelRequestRuntime");
	}
	if (typeof loaded.getModelRequestRuntime !== "function") throw new Error("getModelRequestRuntime is not a function");
	const runtime: unknown = loaded.getModelRequestRuntime();
	if (typeof runtime !== "object" || runtime === null || !("registerGate" in runtime)) {
		throw new Error("runtime copy has no registerGate");
	}
	const registerGate = runtime.registerGate;
	if (typeof registerGate !== "function") throw new Error("registerGate is not a function");
	return (owner, gate) => void Reflect.apply(registerGate, runtime, [owner, gate, undefined]);
}

async function sharedLatch(): Promise<object> {
	const registerFromCopyA = await loadRegisterFromCopy("a");
	const registerFromCopyB = await loadRegisterFromCopy("b");
	registerFromCopyA("owner-a", pass);

	let secondCopyRegistrationError: string | undefined;
	try {
		registerFromCopyB("owner-b", { authorize: pass.authorize });
	} catch (error) {
		secondCopyRegistrationError = error instanceof Error ? error.message : String(error);
	}
	let publicRegistrationError: string | undefined;
	try {
		registerModelRequestGate("owner-c", { authorize: pass.authorize });
	} catch (error) {
		publicRegistrationError = error instanceof Error ? error.message : String(error);
	}
	return {
		registeredSeenByPublicApi: getModelRequestGateInfo().registered,
		secondCopyRegistrationError,
		publicRegistrationError,
	};
}

async function managedTransportBoundary(mode: "none" | "pass" | "deny"): Promise<object> {
	let sinklessWire = 0;
	let managedWire = 0;
	let gateCalls = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			if (new URL(request.url).pathname === "/sinkless") sinklessWire += 1;
			else managedWire += 1;
			return new Response("ok");
		},
	});
	try {
		const modelRef = { provider: "fixture", id: "fixture-1", api: API };
		const fetch = gateFetch(modelRef, "chat", (input, init) => globalThis.fetch(input, init));
		await (await fetch(`${server.url}sinkless`)).text();
		if (mode !== "none") {
			registerModelRequestGate("managed-process-fixture", {
				async authorize() {
					gateCalls += 1;
					return mode === "pass" ? { type: "pass" } : { type: "deny", code: "fixture-deny", message: "denied" };
				},
			});
		}
		// Invalid input only, not a test issuer. A resolved extra field is never proof of a journal receipt.
		const invalidBinding = {} as ModelRequestJournalLeaseBinding;
		const init = {
			sessionId: () => "managed-session",
			root: { kind: "self" as const, modelRequestJournalLeaseBinding: invalidBinding },
			agent: { kind: "main" as const, id: "Main", name: "main", depth: 0 },
			purpose: "main" as const,
			journalConnection: Promise.resolve(),
		};
		const base = createModelRequestSessionExecution(init);
		const executions = [base, deriveModelRequestExecution(base, { purpose: "advisor" })];
		const custom = { wire: 0 };
		registerFakeTransport(custom);
		const denied: boolean[] = [];
		for (const execution of executions) {
			const requests: readonly (() => Promise<unknown>)[] = [
				() => fetch(`${server.url}managed-fetch`),
				() =>
					gatedSend({
						model: modelRef,
						kind: "chat",
						input: `${server.url}managed-send`,
						init: undefined,
						send: () => globalThis.fetch(`${server.url}managed-send`),
					}),
				() => authorizeUninstrumentedAttempt(modelRef, "chat", undefined),
				() => completeSimple(fixtureModel, context, { apiKey: "unused" }),
				() => stream(fixtureModel, context, { apiKey: "unused" }).result(),
			];
			for (const request of requests) {
				try {
					const result: unknown = await runWithModelRequestExecution(execution, request);
					denied.push(isModelRequestDenied(result));
				} catch (error) {
					denied.push(isModelRequestDenied(error));
				}
			}
		}
		return {
			sinklessWire,
			managedWire,
			customStarts: custom.wire,
			gateCalls,
			denied,
			registered: getModelRequestGateInfo().registered,
		};
	} finally {
		await server.stop(true);
	}
}

const scenario = process.argv[2];
let result: object | undefined;
switch (scenario) {
	case "unregistered":
		result = await unregistered();
		break;
	case "shared-latch":
		result = await sharedLatch();
		break;
	case "managed-none":
		result = await managedTransportBoundary("none");
		break;
	case "managed-pass":
		result = await managedTransportBoundary("pass");
		break;
	case "managed-deny":
		result = await managedTransportBoundary("deny");
		break;
}
if (result === undefined) throw new Error(`unknown scenario: ${String(scenario)}`);
console.log(JSON.stringify(result));
