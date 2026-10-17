/**
 * Runs in its own process (a gate registration cannot be undone, so the unregistered state and a gate with
 * `authorizeTimeoutMs` each need a fresh process). Every real pi-ai entry is driven against a loopback provider
 * and one JSON line describes what the caller and the loopback saw.
 */
import { complete, completeSimple, stream, streamSimple } from "@oh-my-pi/pi-ai/stream";
import {
	getModelRequestGateInfo,
	type ModelRequestDecision,
	type ModelRequestGate,
	registerModelRequestGate,
} from "@oh-my-pi/pi-ai/model-request-gate";
import * as AIError from "@oh-my-pi/pi-ai/error";
import type { AssistantMessageEvent, Context, Model } from "@oh-my-pi/pi-ai/types";
import type { Api, AssistantMessage } from "@oh-my-pi/pi-utils/model-data";
import {
	helloContext,
	type LoopbackApi,
	loopbackModel,
	scripted,
	startLoopbackProvider,
	textReplyFor,
} from "../helpers/model-request-loopback";

const APIS: readonly LoopbackApi[] = ["anthropic-messages", "openai-completions", "openai-responses"];
const REPLY_TEXT = "hello from the loopback";
const OPTIONS = { apiKey: "sk-loopback-secret-0123456789" };

type Entry = (model: Model<Api>, context: Context) => Promise<AssistantMessage>;

async function drained(events: AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> }) {
	for await (const _event of events) {
		// The caller consumes every event.
	}
	return events.result();
}

const ENTRIES: ReadonlyArray<readonly [string, Entry]> = [
	["stream", (model, context) => drained(stream(model, context, OPTIONS))],
	["streamSimple", (model, context) => drained(streamSimple(model, context, OPTIONS))],
	["complete", (model, context) => complete(model, context, OPTIONS)],
	["completeSimple", (model, context) => completeSimple(model, context, OPTIONS)],
];

interface Outcome {
	readonly requests: number;
	readonly stopReason?: string;
	readonly text?: string;
	readonly denied?: boolean;
	readonly asked?: number;
}

/** Run every provider through every entry; `describeRun` turns one call into its JSON-able outcome. */
async function drive(
	describeRun: (message: AssistantMessage | undefined, thrown: unknown, requests: number) => Outcome,
): Promise<Record<string, Outcome>> {
	const outcomes: Record<string, Outcome> = {};
	for (const api of APIS) {
		for (const [name, run] of ENTRIES) {
			const loopback = startLoopbackProvider(scripted(textReplyFor(api, REPLY_TEXT)));
			try {
				let message: AssistantMessage | undefined;
				let thrown: unknown;
				try {
					message = await run(loopbackModel(api, loopback.origin), helloContext());
				} catch (error) {
					thrown = error;
				}
				outcomes[`${api}/${name}`] = describeRun(message, thrown, loopback.requests.length);
			} finally {
				loopback.stop();
			}
		}
	}
	return outcomes;
}

async function unregistered(): Promise<object> {
	const outcomes = await drive((message, _thrown, requests) => ({
		requests,
		stopReason: message?.stopReason,
		text: message?.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join(""),
	}));
	return { registered: getModelRequestGateInfo().registered, outcomes };
}

async function authorizeTimeout(): Promise<object> {
	let asked = 0;
	const gate: ModelRequestGate = {
		authorize(): Promise<ModelRequestDecision> {
			asked += 1;
			return Promise.withResolvers<ModelRequestDecision>().promise;
		},
	};
	registerModelRequestGate("transport-process-fixture", gate, { authorizeTimeoutMs: 50 });
	let timeoutMessage: string | undefined;
	const outcomes = await drive((message, thrown, requests) => {
		const before = asked;
		asked = 0;
		timeoutMessage ??= message?.errorMessage;
		return { requests, denied: AIError.isModelRequestDenied(message ?? thrown), asked: before };
	});
	return { outcomes, timeoutMessage };
}

const scenario = process.argv[2];
const result =
	scenario === "unregistered"
		? await unregistered()
		: scenario === "authorize-timeout"
			? await authorizeTimeout()
			: undefined;
if (result === undefined) throw new Error(`unknown scenario: ${String(scenario)}`);
console.log(JSON.stringify(result));
