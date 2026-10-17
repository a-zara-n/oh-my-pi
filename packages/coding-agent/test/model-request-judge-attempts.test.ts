/**
 * Every wire attempt of a judgment goes through the registered model-request gate, and the gate is told which kind of
 * re-attempt it is: a judge's own resend, or the next candidate of the judge-role chain. The on-device candidate never
 * reaches the gate. The providers here are loopback servers; the gate is the shared fixture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { ChoiceQuestion, Model, NoulQuestion } from "@oh-my-pi/pi-ai";
import type { Api } from "@oh-my-pi/pi-utils/model-data";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ChainJudge, JudgmentCache } from "@oh-my-pi/pi-coding-agent/judgment";
import { tinyModelClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import { TempDir } from "@oh-my-pi/pi-utils";
import { installFixtureGate } from "../../ai/test/helpers/model-request-gate-fixture";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const gate = installFixtureGate();

const TIER_QUESTION: ChoiceQuestion<"low" | "high"> = {
	type: "choice",
	instructions: "Choose the reasoning tier.",
	criteria: { low: "simple", high: "complex" },
};

const LOCAL = getBundledModel("local", "qwen2.5-1.5b");
if (!LOCAL) throw new Error("Expected the bundled on-device judge model");

const CHAT_PROVIDER = "loopback-judge-chat";

interface LoopbackRequest {
	readonly path: string;
	readonly model: string | undefined;
}

let server: Bun.Server<undefined>;
let respond: (request: LoopbackRequest) => Response;
const seen: LoopbackRequest[] = [];

function overloaded(): Response {
	return new Response(JSON.stringify({ error: { message: "overloaded" } }), {
		status: 503,
		headers: { "content-type": "application/json", "retry-after-ms": "1" },
	});
}

function rejected(): Response {
	return new Response(JSON.stringify({ error: { message: "bad request" } }), {
		status: 400,
		headers: { "content-type": "application/json" },
	});
}

function systemOneAnswer(): Response {
	return Response.json({
		model: "jev-loopback",
		answers: { level: { type: "choice", choice: "high" } },
		usage: { input_tokens: 8, output_tokens: 2 },
	});
}

function chatAnswer(text: string): Response {
	const chunk = (delta: unknown, finish: string | null) =>
		JSON.stringify({
			id: "chatcmpl-1",
			object: "chat.completion.chunk",
			created: 0,
			choices: [{ index: 0, delta, finish_reason: finish }],
		});
	return new Response(`data: ${chunk({ content: text }, null)}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

beforeEach(() => {
	gate.reset();
	seen.length = 0;
	respond = () => chatAnswer("level: high");
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = request.method === "POST" ? ((await request.json()) as { model?: string }) : {};
			const entry: LoopbackRequest = { path: new URL(request.url).pathname, model: body.model };
			seen.push(entry);
			return respond(entry);
		},
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	await server.stop(true);
	gate.reset();
});

function nativeModel(init: { id: string; api: "typesafe" | "openrouter-decisions"; provider: string }): Model<Api> {
	return {
		id: init.id,
		name: init.id,
		api: init.api,
		provider: init.provider,
		baseUrl: `http://127.0.0.1:${server.port}`,
		kind: "judge",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	} as Model<Api>;
}

function chatModel(id: string): Model<Api> {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: CHAT_PROVIDER,
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8000,
		maxTokens: 1000,
	});
}

function chain(models: Model<Api>[]): { settings: Settings; registry: ModelRegistry } {
	const [first, ...rest] = models;
	const settings = Settings.isolated({
		modelRoles: { judge: `${first.provider}/${first.id}` },
		"retry.fallbackChains": { judge: rest.map(model => `${model.provider}/${model.id}`) },
	});
	const authStorage = createInMemoryAuthStorage();
	for (const model of models) authStorage.keys.setRuntime(model.provider, "loopback-key");
	const registry = new ModelRegistry(authStorage, "/nonexistent/model-request-judge-attempts.yml");
	vi.spyOn(registry, "getAvailable").mockReturnValue(models);
	return { settings, registry };
}

const REQUEST = { state: "rename a local", questions: { level: TIER_QUESTION } };

describe("ChainJudge and the model-request gate", () => {
	it("tells the gate a native candidate's resends are judge-attempts and the next candidate a judge-candidate", async () => {
		const primary = nativeModel({ id: "jev-primary", api: "typesafe", provider: "typesafe" });
		const secondary = nativeModel({
			id: "~typesafe/jev-secondary",
			api: "openrouter-decisions",
			provider: "openrouter",
		});
		respond = request => (request.path === "/decisions" ? systemOneAnswer() : overloaded());
		const { settings, registry } = chain([primary, secondary]);

		const result = await new ChainJudge({ settings, registry, purpose: "test" }).judge(REQUEST);

		expect(result.answers.level.choice).toBe("high");
		expect(seen.map(request => request.path)).toEqual([
			"/v1/systemone",
			"/v1/systemone",
			"/v1/systemone",
			"/decisions",
		]);
		expect(gate.attempts.map(attempt => [attempt.reason, attempt.kind, attempt.model.id])).toEqual([
			["first", "judgment", "jev-primary"],
			["judge-attempt", "judgment", "jev-primary"],
			["judge-attempt", "judgment", "jev-primary"],
			["judge-candidate", "judgment", "~typesafe/jev-secondary"],
		]);
		// One chain across the walk: each attempt names the one before it.
		expect(gate.attempts.map(attempt => attempt.retryOf)).toEqual([
			undefined,
			gate.attempts[0].attemptId,
			gate.attempts[1].attemptId,
			gate.attempts[2].attemptId,
		]);
	});

	it("tells the gate the second chat candidate is a judge-candidate after the first one's request failed", async () => {
		const first = chatModel("judge-chat-first");
		const second = chatModel("judge-chat-second");
		respond = request => (request.model === first.id ? rejected() : chatAnswer("level: high"));
		const { settings, registry } = chain([first, second]);

		const result = await new ChainJudge({ settings, registry, purpose: "test" }).judge(REQUEST);

		expect(result.answers.level.choice).toBe("high");
		expect(seen.map(request => request.model)).toEqual([first.id, second.id]);
		expect(gate.attempts.map(attempt => [attempt.reason, attempt.kind, attempt.model.id])).toEqual([
			["first", "chat", first.id],
			["judge-candidate", "chat", second.id],
		]);
		expect(gate.attempts[1].retryOf).toBe(gate.attempts[0].attemptId);
	});

	it("never shows the on-device candidate to the gate and still labels the candidate after it", async () => {
		const chat = chatModel("judge-chat-after-local");
		const { settings, registry } = chain([LOCAL, chat]);
		const local = vi.spyOn(tinyModelClient, "complete").mockResolvedValueOnce("low");

		const onDevice = await new ChainJudge({ settings, registry, purpose: "test" }).judge(REQUEST);

		expect(onDevice.answers.level.choice).toBe("low");
		expect(local).toHaveBeenCalledTimes(1);
		expect(gate.attempts).toHaveLength(0);
		expect(seen).toHaveLength(0);

		local.mockResolvedValueOnce(null);
		const afterLocalFailed = await new ChainJudge({ settings, registry, purpose: "test" }).judge(REQUEST);

		expect(afterLocalFailed.answers.level.choice).toBe("high");
		expect(seen.map(request => request.model)).toEqual([chat.id]);
		expect(gate.attempts.map(attempt => [attempt.reason, attempt.kind])).toEqual([["judge-candidate", "chat"]]);
		expect(gate.attempts[0].retryOf).toBeUndefined();
	});

	it("stops at a denied first candidate: no request leaves and the second candidate is never asked", async () => {
		const first = chatModel("judge-chat-denied");
		const second = chatModel("judge-chat-never-asked");
		gate.setHandler(() => ({ type: "deny", code: "refused", message: "503 overloaded, try again" }));
		const { settings, registry } = chain([first, second]);

		const failure = await new ChainJudge({ settings, registry, purpose: "test" })
			.judge(REQUEST)
			.catch((error: unknown) => error);

		expect(AIError.isModelRequestDenied(failure)).toBe(true);
		expect(seen).toHaveLength(0);
		expect(gate.attempts.map(attempt => attempt.model.id)).toEqual([first.id]);
	});

	it("answers a repeated question from the judgment cache without asking the gate again", async () => {
		using tempDir = TempDir.createSync("@omp-judge-attempts-cache-");
		const cache = JudgmentCache.open(path.join(tempDir.path(), "judgment-cache.db"));
		try {
			const primary = nativeModel({ id: "jev-cached", api: "typesafe", provider: "typesafe" });
			respond = () =>
				Response.json({
					model: "jev-loopback",
					answers: { a: { type: "noul", noul: 0.9 } },
					usage: { input_tokens: 4, output_tokens: 1 },
				});
			const { settings, registry } = chain([primary]);
			const judge = new ChainJudge({ settings, registry, purpose: "test", cache });
			const question: NoulQuestion = { type: "noul", instructions: "A?" };

			await judge.judge({ state: "same state", questions: { a: question } });
			const repeated = await judge.judge({ state: "same state", questions: { a: question } });

			expect(repeated.answers.a.noul).toBe(0.9);
			expect(seen).toHaveLength(1);
			expect(gate.attempts).toHaveLength(1);
		} finally {
			cache.close();
		}
	});
});
