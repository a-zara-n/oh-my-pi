import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { completeSimple } from "@oh-my-pi/pi-ai";
import { type ApiKeyResolveContext, withAuth } from "@oh-my-pi/pi-ai/auth-retry";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { TypeSafeJudge } from "@oh-my-pi/pi-ai/judgment";
import { gateFetch } from "@oh-my-pi/pi-ai/model-request-execution";
import { retryTransientCompletion } from "@oh-my-pi/pi-ai/oneshot-retry";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import type { Api } from "@oh-my-pi/pi-utils/model-data";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { installFixtureGate } from "./helpers/model-request-gate-fixture";

/**
 * A gate that audits a model request sees every wire attempt and must be able to tell a first send from the kind of
 * re-attempt that followed it. These tests drive the real provider code against a loopback server and read what the
 * gate was told.
 */

const gate = installFixtureGate();

interface LoopbackRequest {
	authorization: string | null;
}

type LoopbackResponder = (request: LoopbackRequest, index: number) => Response;

function responsesSse(): Response {
	const frames = [
		{ type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{
			type: "response.content_part.added",
			item_id: "msg_1",
			output_index: 0,
			content_index: 0,
			part: { type: "output_text", text: "", annotations: [] },
		},
		{ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "ok" },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "ok", annotations: [] }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp_1",
				status: "completed",
				output: [],
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			},
		},
	];
	return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function overloaded(): Response {
	return new Response(JSON.stringify({ error: { message: "overloaded" } }), {
		status: 503,
		headers: { "content-type": "application/json", "retry-after-ms": "1" },
	});
}

/** A proxy admission rejection: the transport surfaces it at once instead of retrying it itself. */
function admissionRejected(): Response {
	const error = { message: "admission rejected", rate_limit_type: "max_parallel_requests" };
	return new Response(JSON.stringify({ error }), { status: 429, headers: { "content-type": "application/json" } });
}

let server: Bun.Server<undefined>;
let respond: LoopbackResponder;
const seen: LoopbackRequest[] = [];

beforeEach(() => {
	gate.reset();
	seen.length = 0;
	respond = responsesSse;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const entry: LoopbackRequest = { authorization: request.headers.get("authorization") };
			seen.push(entry);
			return respond(entry, seen.length - 1);
		},
	});
});

afterEach(async () => {
	await server.stop(true);
	gate.reset();
});

function responsesModel(): Model<Api> {
	return buildModel({
		id: "loopback-chat",
		name: "Loopback Chat",
		api: "openai-responses",
		provider: "loopback-provider",
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8000,
		maxTokens: 1000,
	});
}

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

describe("provider retry", () => {
	test("tells the gate the transport's own resend after a transient 503 is a provider-retry in the same logical request", async () => {
		respond = (_request, index) => (index === 0 ? overloaded() : responsesSse());

		const message = await completeSimple(responsesModel(), context, { apiKey: "key-0" });

		expect(message.stopReason).toBe("stop");
		expect(seen).toHaveLength(2);
		const [first, second] = gate.attempts;
		expect(gate.attempts.map(attempt => attempt.reason)).toEqual(["first", "provider-retry"]);
		expect(second.retryOf).toBe(first.attemptId);
		expect(second.requestId).toBe(first.requestId);
	});
});

describe("oneshot retry", () => {
	test("tells the gate the resend after a surfaced transient failure is a oneshot-retry of the first attempt", async () => {
		respond = (_request, index) => (index === 0 ? admissionRejected() : responsesSse());

		const message = await retryTransientCompletion(
			() => completeSimple(responsesModel(), context, { apiKey: "key-0" }),
			{ baseDelayMs: 1 },
		);

		expect(message.stopReason).toBe("stop");
		expect(seen).toHaveLength(2);
		const [first, second] = gate.attempts;
		expect(gate.attempts.map(attempt => attempt.reason)).toEqual(["first", "oneshot-retry"]);
		expect(first.retryOf).toBeUndefined();
		expect(second.retryOf).toBe(first.attemptId);
		expect(second.requestId).not.toBe(first.requestId);
		expect(second.kind).toBe("chat");
	});

	test("a denied attempt reaches no provider and is not retried", async () => {
		gate.setHandler(() => ({ type: "deny", code: "refused", message: "503 overloaded, try again" }));

		const message = await retryTransientCompletion(
			() => completeSimple(responsesModel(), context, { apiKey: "key-0" }),
			{ baseDelayMs: 1 },
		);

		expect(message.stopReason).toBe("error");
		expect(AIError.isModelRequestDenied(message)).toBe(true);
		expect(seen).toHaveLength(0);
		expect(gate.attempts).toHaveLength(1);
	});
});

describe("credential rotation", () => {
	test("tells the gate the resend with the rotated credential is an auth-rotation", async () => {
		respond = request =>
			request.authorization === "Bearer key-0"
				? new Response(JSON.stringify({ error: { message: "invalid api key" } }), {
						status: 401,
						headers: { "content-type": "application/json" },
					})
				: responsesSse();
		const resolver = (ctx: ApiKeyResolveContext) => (ctx.error === undefined ? "key-0" : "key-1");

		const message = await completeSimple(responsesModel(), context, { apiKey: resolver });

		expect(message.stopReason).toBe("stop");
		expect(seen.map(request => request.authorization)).toEqual(["Bearer key-0", "Bearer key-1"]);
		const [first, second] = gate.attempts;
		expect(gate.attempts.map(attempt => attempt.reason)).toEqual(["first", "auth-rotation"]);
		expect(second.retryOf).toBe(first.attemptId);
		expect(second.requestId).toBe(first.requestId);
	});
});

describe("withAuth", () => {
	test("tells the gate a request re-sent by a non-streaming helper after rotating credentials is an auth-rotation", async () => {
		respond = request =>
			request.authorization === "Bearer key-0"
				? new Response("invalid api key", { status: 401 })
				: new Response("ok");
		const send = gateFetch({ provider: "loopback-provider", id: "helper", api: "helper" }, "chat", fetch);

		const body = await withAuth(
			(ctx: ApiKeyResolveContext) => (ctx.error === undefined ? "key-0" : "key-1"),
			async key => {
				const response = await send(`http://127.0.0.1:${server.port}/`, {
					method: "POST",
					headers: { Authorization: `Bearer ${key}` },
					body: "{}",
				});
				if (!response.ok) throw new AIError.ProviderHttpError(await response.text(), response.status);
				return response.text();
			},
		);

		expect(body).toBe("ok");
		expect(seen.map(request => request.authorization)).toEqual(["Bearer key-0", "Bearer key-1"]);
		const [first, second] = gate.attempts;
		expect(gate.attempts.map(attempt => attempt.reason)).toEqual(["first", "auth-rotation"]);
		expect(second.retryOf).toBe(first.attemptId);
	});
});

describe("TypeSafeJudge", () => {
	const request = {
		state: "payouts have failed for three days",
		questions: { urgent: { type: "noul", instructions: "Does this convey urgency?" } },
	} as const;

	function judge(): TypeSafeJudge {
		return new TypeSafeJudge({
			apiKey: "ts-key",
			baseUrl: `http://127.0.0.1:${server.port}`,
			model: "jev-test",
			fetch: gateFetch(
				{ provider: "typesafe", id: "jev-test", api: "typesafe", baseUrl: `http://127.0.0.1:${server.port}` },
				"judgment",
				fetch,
			),
		});
	}

	function answered(): Response {
		return Response.json({
			model: "jev-test",
			answers: { urgent: { type: "noul", noul: 0.9 } },
			usage: { input_tokens: 5, output_tokens: 1 },
		});
	}

	test("tells the gate the resend after a transient 503 is a judge-attempt within the same logical request", async () => {
		respond = (_request, index) => (index === 0 ? overloaded() : answered());

		const result = await judge().judge(request);

		expect(result.answers.urgent.noul).toBe(0.9);
		expect(seen).toHaveLength(2);
		const [first, second] = gate.attempts;
		expect(gate.attempts.map(attempt => [attempt.reason, attempt.kind])).toEqual([
			["first", "judgment"],
			["judge-attempt", "judgment"],
		]);
		expect(second.retryOf).toBe(first.attemptId);
		expect(second.requestId).toBe(first.requestId);
	});

	test("a denied judgment reaches no provider and is not retried", async () => {
		gate.setHandler(() => ({ type: "deny", code: "refused", message: "503 overloaded, try again" }));

		const failure = await judge()
			.judge(request)
			.then(
				() => undefined,
				(error: unknown) => error,
			);

		expect(AIError.isModelRequestDenied(failure)).toBe(true);
		expect(seen).toHaveLength(0);
		expect(gate.attempts).toHaveLength(1);
	});
});
