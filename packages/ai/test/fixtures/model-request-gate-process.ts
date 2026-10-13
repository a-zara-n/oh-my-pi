/**
 * Runs in its own process (a gate registration cannot be undone, so process-wide behavior needs a fresh one).
 * Prints one JSON object describing what a consumer of the public API observed.
 *
 * Scenarios (argv[2]):
 *  - unregistered: a request through the real `completeSimple` entry with no gate registered reaches the transport.
 *  - shared-latch: a second copy of the runtime module cannot hold a different gate than the first.
 */
import { completeSimple, registerCustomApi } from "@oh-my-pi/pi-ai";
import { authorizeModelRequest } from "@oh-my-pi/pi-ai/model-request-execution";
import {
	getModelRequestGateInfo,
	type ModelRequestDecision,
	type ModelRequestGate,
	registerModelRequestGate,
} from "@oh-my-pi/pi-ai/model-request-gate";
import type { Api, AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

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

/** A fake transport: what a per-attempt hook does before it lets bytes leave. */
function registerFakeTransport(counter: { wire: number }): void {
	registerCustomApi(API, (model, _context, options) => {
		const stream = new AssistantMessageEventStream();
		void authorizeModelRequest({
			requestId: "fixture-request",
			reason: "first",
			kind: "chat",
			model: { provider: model.provider, id: model.id, api: model.api },
			wire: undefined,
			signal: options?.signal,
		}).then(
			() => {
				counter.wire += 1;
				const message = assistant("ok");
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			},
			error => stream.fail(error),
		);
		return stream;
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

const scenario = process.argv[2];
const result = scenario === "unregistered" ? await unregistered() : scenario === "shared-latch" ? await sharedLatch() : undefined;
if (result === undefined) throw new Error(`unknown scenario: ${String(scenario)}`);
console.log(JSON.stringify(result));
