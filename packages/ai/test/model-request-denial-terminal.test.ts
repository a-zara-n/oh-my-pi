import { afterEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import type { ApiKeyResolveContext } from "@oh-my-pi/pi-ai";
import { completeSimple, registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { retryTransientCompletion } from "@oh-my-pi/pi-ai/oneshot-retry";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { AnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai/types";
import type { Api, AssistantMessage, Usage } from "@oh-my-pi/pi-utils/model-data";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * A gate denial must stop the turn where it happened. Its wording is the gate's own, so it can
 * resemble anything a provider says (a 429 usage limit, a 503 overload); the retry, credential
 * rotation and backoff layers must key off the structured denial flag, never that text.
 */

const SOURCE_ID = "model-request-denial-terminal-test";
const API = "model-request-denial-terminal-test" as Api;

const LOOKALIKE_TEXT = "429 You have hit your ChatGPT usage limit (pro plan). Try again in ~158 min. 503 overloaded";

function denial(): AIError.ModelRequestDeniedError {
	return new AIError.ModelRequestDeniedError("gate_refused", LOOKALIKE_TEXT);
}

function usage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(content: string[] = []): AssistantMessage {
	return {
		role: "assistant",
		content: content.map(text => ({ type: "text" as const, text })),
		api: API,
		provider: "test-provider",
		model: "test-model",
		timestamp: 1,
		stopReason: "stop",
		usage: usage(),
	};
}

/** Flatten an error into an error-stop message the way provider catch blocks do (`finalize`). */
async function flattenedError(error: unknown): Promise<AssistantMessage> {
	const result = await AIError.finalize(error, { api: API });
	return {
		...assistant(),
		stopReason: result.stopReason,
		errorStatus: result.status,
		errorId: result.id,
		errorMessage: result.message,
	};
}

function model(): Model<Api> {
	return {
		id: "test-model",
		name: "Test Model",
		api: API,
		provider: "test-provider",
		contextWindow: 1000,
		maxTokens: 100,
	} as Model<Api>;
}

const context: Context = {
	systemPrompt: [],
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

function okStream(stream: AssistantMessageEventStream): void {
	const message = assistant(["ok"]);
	stream.push({ type: "start", partial: message });
	stream.push({ type: "done", reason: "stop", message });
}

/** Resolver that hands out a fresh key per rotation and records every resolution request. */
function rotatingResolver(contexts: ApiKeyResolveContext[]): SimpleStreamOptions["apiKey"] {
	return async ctx => {
		contexts.push(ctx);
		return ctx.error === undefined ? "key-0" : `key-${contexts.length}`;
	};
}

describe("auth-rotation loop with a denied request", () => {
	afterEach(() => {
		unregisterCustomApis(SOURCE_ID);
	});

	it("does not rotate credentials or resend when a denial worded like a usage-limit 429 is flattened into an error message", async () => {
		let transportCalls = 0;
		registerCustomApi(
			API,
			() => {
				transportCalls += 1;
				const stream = new AssistantMessageEventStream();
				void flattenedError(denial()).then(message => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "error", reason: "error", error: message });
				});
				return stream;
			},
			SOURCE_ID,
		);
		const contexts: ApiKeyResolveContext[] = [];

		const result = await completeSimple(model(), context, { apiKey: rotatingResolver(contexts) });

		expect(transportCalls).toBe(1);
		// Only the initial resolution: no refresh-same and no sibling rotation was requested.
		expect(contexts.map(ctx => ctx.error)).toEqual([undefined]);
		expect(result.stopReason).toBe("error");
		expect(AIError.isModelRequestDenied(result)).toBe(true);
		expect(AIError.is(result.errorId, AIError.Flag.UsageLimit)).toBe(false);
		expect(AIError.retriable(result.errorId)).toBe(false);
	});

	it("rejects with the denial itself after one transport call when the provider throws it", async () => {
		let transportCalls = 0;
		const thrown = denial();
		registerCustomApi(
			API,
			() => {
				transportCalls += 1;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => stream.fail(thrown));
				return stream;
			},
			SOURCE_ID,
		);
		const contexts: ApiKeyResolveContext[] = [];

		const stream = streamSimple(model(), context, { apiKey: rotatingResolver(contexts) });
		await expect(
			(async () => {
				for await (const _event of stream) {
					// drain
				}
			})(),
		).rejects.toBe(thrown);

		expect(transportCalls).toBe(1);
		expect(contexts.map(ctx => ctx.error)).toEqual([undefined]);
	});

	it("still rotates to a sibling credential for the same wording when it is a genuine usage-limit 429", async () => {
		const keys: unknown[] = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				keys.push(options?.apiKey);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() =>
					keys.length === 1
						? stream.fail(Object.assign(new Error(LOOKALIKE_TEXT), { status: 429 }))
						: okStream(stream),
				);
				return stream;
			},
			SOURCE_ID,
		);
		const contexts: ApiKeyResolveContext[] = [];

		const result = await completeSimple(model(), context, { apiKey: rotatingResolver(contexts) });

		expect(result.stopReason).toBe("stop");
		expect(keys).toHaveLength(2);
	});
});

describe("retryTransientCompletion with a denied request", () => {
	it("does not re-issue a thrown denial whose text claims a transient 429", async () => {
		let attempts = 0;
		const thrown = denial();

		await expect(
			retryTransientCompletion(
				async () => {
					attempts += 1;
					throw thrown;
				},
				{ baseDelayMs: 1, maxAttempts: 3 },
			),
		).rejects.toBe(thrown);

		expect(attempts).toBe(1);
	});

	it("does not re-issue a denial-flagged error message whose text claims a transient 429", async () => {
		let attempts = 0;
		const failed = await flattenedError(denial());
		// A provider that reports a status next to the denial text must not make it transient either.
		failed.errorStatus = 429;

		const result = await retryTransientCompletion(
			async () => {
				attempts += 1;
				return failed;
			},
			{ baseDelayMs: 1, maxAttempts: 3 },
		);

		expect(attempts).toBe(1);
		expect(result).toBe(failed);
		expect(AIError.isModelRequestDenied(result)).toBe(true);
	});
});

describe("provider-internal retry loop with a denied request", () => {
	const anthropicModel: Model<"anthropic-messages"> = buildModel({
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	});
	const anthropicContext: Context = { messages: [{ role: "user", content: "Say hi", timestamp: 1 }] };
	const overloadedText = "503 overloaded_error: Overloaded";

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function rejectedRequest(error: Error) {
		return {
			async withResponse(): Promise<never> {
				throw error;
			},
		};
	}

	it("does not back off and resend the Anthropic request when the gate denies it with overload wording", async () => {
		let attempts = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => {
			attempts += 1;
			return rejectedRequest(new AIError.ModelRequestDeniedError("gate_refused", overloadedText)) as never;
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		const stream = streamAnthropic(anthropicModel, anthropicContext, {
			apiKey: "sk-ant-test",
			providerRetryWait: async () => {},
		});
		for await (const _event of stream) {
			// drain
		}
		const result = await stream.result();

		expect(attempts).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(AIError.isModelRequestDenied(result)).toBe(true);
	});

	it("does resend the Anthropic request for the same overload wording when it is a real 503", async () => {
		let attempts = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => {
			attempts += 1;
			if (attempts === 1) {
				return rejectedRequest(Object.assign(new Error(overloadedText), { status: 503 })) as never;
			}
			return rejectedRequest(new Error("stop after the retry")) as never;
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		const stream = streamAnthropic(anthropicModel, anthropicContext, {
			apiKey: "sk-ant-test",
			providerRetryWait: async () => {},
		});
		for await (const _event of stream) {
			// drain
		}
		await stream.result();

		expect(attempts).toBe(2);
	});

	it("keeps a denial out of the shared provider-retry predicate", () => {
		expect(
			AIError.isProviderRetryableError(new AIError.ModelRequestDeniedError("gate_refused", overloadedText)),
		).toBe(false);
		expect(AIError.isProviderRetryableError(new Error(overloadedText))).toBe(true);
	});
});
