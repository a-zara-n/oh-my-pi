import { setImmediate } from "node:timers/promises";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * A fake model provider on 127.0.0.1: scripted per-request replies, every received request recorded. Nothing here
 * leaves the machine. Used to drive the real provider code through the real pi-ai entries.
 */

export interface LoopbackRequest {
	readonly method: string;
	/** Path and query as received (no scheme or host). */
	readonly target: string;
	/** Header names lowercased. */
	readonly headers: Readonly<Record<string, string>>;
	/** The bytes received on the wire. */
	readonly body: Uint8Array;
}

export interface LoopbackReply {
	readonly status: number;
	readonly headers?: Readonly<Record<string, string>>;
	/** The body, delivered as one network write per chunk. */
	readonly chunks: readonly string[];
	/** After the last chunk, drop the connection instead of ending the body cleanly. */
	readonly dropAfterChunks?: boolean;
	/** Hold the reply (before the status line) until this settles; lets a test act while the request is in flight. */
	readonly holdUntil?: Promise<void>;
}

export type LoopbackResponder = (request: LoopbackRequest, index: number) => LoopbackReply | Promise<LoopbackReply>;

export interface LoopbackProvider {
	/** `http://127.0.0.1:<port>` */
	readonly origin: string;
	/** Requests received so far, in arrival order. */
	readonly requests: readonly LoopbackRequest[];
	/** Resolves once at least `count` requests have arrived. */
	arrived(count: number): Promise<void>;
	stop(): void;
}

export interface LoopbackOptions {
	/** Receives `"loopback-request"` when a request arrives, so a test can order it against gate and lease calls. */
	readonly trace?: string[];
}

/** Replies by arrival order; the last reply repeats once the script is exhausted. */
export function scripted(...replies: readonly LoopbackReply[]): LoopbackResponder {
	if (replies.length === 0) throw new Error("scripted() needs at least one reply");
	return (_request, index) => replies[Math.min(index, replies.length - 1)]!;
}

/** The exact bytes a reply sends. */
export function replyBody(reply: LoopbackReply): string {
	return reply.chunks.join("");
}

function sseFrames(events: readonly unknown[], withEventName: boolean): string[] {
	return events.map(event => {
		const data = typeof event === "string" ? event : JSON.stringify(event);
		const name =
			withEventName && typeof event === "object" && event !== null && "type" in event ? event.type : undefined;
		return `${name === undefined ? "" : `event: ${String(name)}\n`}data: ${data}\n\n`;
	});
}

const SSE_HEADERS = { "content-type": "text/event-stream" } as const;

/** A 200 server-sent-events reply, one chunk per event. */
export function sseReply(events: readonly unknown[], options: { readonly eventNames?: boolean } = {}): LoopbackReply {
	return { status: 200, headers: SSE_HEADERS, chunks: sseFrames(events, options.eventNames ?? false) };
}

/** A JSON error reply in the shape the provider SDKs parse. */
export function errorReply(
	status: number,
	message: string,
	headers: Readonly<Record<string, string>> = {},
): LoopbackReply {
	return {
		status,
		headers: { "content-type": "application/json", ...headers },
		chunks: [JSON.stringify({ type: "error", error: { type: "api_error", message, code: null } })],
	};
}

export function anthropicTextReply(text: string): LoopbackReply {
	return sseReply(
		[
			{
				type: "message_start",
				message: {
					id: "msg_loopback",
					type: "message",
					role: "assistant",
					model: "claude-sonnet-4-5",
					content: [],
					usage: { input_tokens: 1, output_tokens: 0 },
				},
			},
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
			{ type: "message_stop" },
		],
		{ eventNames: true },
	);
}

export function openAICompletionsTextReply(text: string): LoopbackReply {
	const chunk = { id: "chatcmpl-loopback", object: "chat.completion.chunk", created: 0, model: "gpt-4o-mini" };
	return sseReply([
		{ ...chunk, choices: [{ index: 0, delta: { content: text } }] },
		{
			...chunk,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		},
		"[DONE]",
	]);
}

export function openAIResponsesTextReply(text: string): LoopbackReply {
	return sseReply([
		{ type: "response.created", response: { id: "resp_loopback" } },
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_loopback", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: text },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_loopback",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp_loopback",
				status: "completed",
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					total_tokens: 2,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		},
	]);
}

function lowercased(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	headers.forEach((value, name) => {
		out[name.toLowerCase()] = value;
	});
	return out;
}

function replyStream(reply: LoopbackReply): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let next = 0;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (next >= reply.chunks.length) {
				if (reply.dropAfterChunks) controller.error(new Error("loopback dropped the connection"));
				else controller.close();
				return;
			}
			controller.enqueue(encoder.encode(reply.chunks[next]!));
			next += 1;
			// Yield so each write can reach the socket as its own network chunk.
			await setImmediate();
		},
	});
}

/** Start a fake provider on an ephemeral 127.0.0.1 port. Call `stop()` when done. */
export function startLoopbackProvider(responder: LoopbackResponder, options: LoopbackOptions = {}): LoopbackProvider {
	const requests: LoopbackRequest[] = [];
	const waiters: Array<{ count: number; resolve: () => void }> = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		async fetch(request) {
			const body = new Uint8Array(await request.arrayBuffer());
			const url = new URL(request.url);
			const received: LoopbackRequest = {
				method: request.method,
				target: `${url.pathname}${url.search}`,
				headers: lowercased(request.headers),
				body,
			};
			const index = requests.length;
			requests.push(received);
			options.trace?.push("loopback-request");
			for (const waiter of waiters) if (requests.length >= waiter.count) waiter.resolve();
			const reply = await responder(received, index);
			if (reply.holdUntil !== undefined) await reply.holdUntil;
			return new Response(replyStream(reply), { status: reply.status, headers: reply.headers });
		},
	});
	return {
		origin: `http://127.0.0.1:${server.port}`,
		requests,
		arrived(count) {
			if (requests.length >= count) return Promise.resolve();
			const pending = Promise.withResolvers<void>();
			waiters.push({ count, resolve: pending.resolve });
			return pending.promise;
		},
		stop() {
			server.stop(true);
		},
	};
}

/** The text the caller sent, decoded. */
export function bodyText(request: LoopbackRequest): string {
	return new TextDecoder().decode(request.body);
}

export type LoopbackApi = "anthropic-messages" | "openai-completions" | "openai-responses";

const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/** A real catalog-built model of `api` pointed at the loopback provider. */
export function loopbackModel<TApi extends LoopbackApi>(api: TApi, origin: string): Model<TApi> {
	if (api === "anthropic-messages") {
		return buildModel({
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			api,
			provider: "anthropic",
			baseUrl: origin,
			reasoning: false,
			input: ["text"],
			cost: COST,
			contextWindow: 200_000,
			maxTokens: 8_192,
		});
	}
	return buildModel({
		id: "gpt-4o-mini",
		name: "GPT-4o mini",
		api,
		provider: "openai",
		baseUrl: `${origin}/v1`,
		reasoning: false,
		input: ["text"],
		cost: COST,
		contextWindow: 128_000,
		maxTokens: 4_096,
	});
}

/** The reply a provider of `api` sends for a successful one-text-block answer. */
export function textReplyFor(api: LoopbackApi, text: string): LoopbackReply {
	switch (api) {
		case "anthropic-messages":
			return anthropicTextReply(text);
		case "openai-completions":
			return openAICompletionsTextReply(text);
		case "openai-responses":
			return openAIResponsesTextReply(text);
	}
}

export function helloContext(): Context {
	return { messages: [{ role: "user", content: "Say hello", timestamp: 1 }] };
}
