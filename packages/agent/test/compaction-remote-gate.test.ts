import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { requestOpenAiRemoteCompaction, requestRemoteCompaction } from "@oh-my-pi/pi-agent-core/compaction/openai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import type { Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { installFixtureGate } from "../../ai/test/helpers/model-request-gate-fixture";

/**
 * Remote compaction is a model request sent without going through the provider stream. Every one of its wire sends
 * must still reach the registered gate before any byte leaves, with the same credential-free description a streamed
 * turn gets.
 */

const gate = installFixtureGate();

interface LoopbackRequest {
	method: string;
	path: string;
	body: string;
}

let server: Bun.Server<undefined>;
const seen: LoopbackRequest[] = [];

beforeEach(() => {
	gate.reset();
	seen.length = 0;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			seen.push({ method: request.method, path: new URL(request.url).pathname, body: await request.text() });
			if (request.url.endsWith("/chat/completions")) {
				return Response.json({ choices: [{ message: { content: "summary" } }] });
			}
			return Response.json({ output: [{ type: "compaction", encrypted_content: "enc" }] });
		},
	});
});

afterEach(async () => {
	await server.stop(true);
	gate.reset();
});

function openAiModel(): Model<"openai-responses"> {
	return buildModel({
		id: "gpt-loopback",
		name: "GPT Loopback",
		api: "openai-responses",
		provider: "loopback-openai",
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: 128_000,
	});
}

const compactInput = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }];

describe("requestOpenAiRemoteCompaction", () => {
	test("reaches the gate as one chat attempt that describes the request without its credential", async () => {
		const result = await requestOpenAiRemoteCompaction(openAiModel(), "secret-key", compactInput, "compact it");

		expect(result.compactionItem.type).toBe("compaction");
		expect(gate.attempts).toHaveLength(1);
		const [attempt] = gate.attempts;
		expect([attempt.kind, attempt.reason, attempt.model.id, attempt.model.provider]).toEqual([
			"chat",
			"first",
			"gpt-loopback",
			"loopback-openai",
		]);
		const wire = attempt.wire;
		if (wire === undefined) throw new Error("the gate was not shown the request");
		expect(wire.method).toBe("POST");
		expect(new URL(wire.url).pathname).toBe("/v1/responses/compact");
		expect(Object.keys(wire.headers).map(name => name.toLowerCase())).not.toContain("authorization");
		expect(wire.bodyBytes).toBeGreaterThan(0);
		const shown = JSON.parse(new TextDecoder().decode(await wire.readBody())) as {
			input: unknown;
			instructions: string;
		};
		expect(shown.instructions).toBe("compact it");
		expect(shown.input).toEqual(compactInput);
		expect(seen).toHaveLength(1);
		expect(seen[0].body).toBe(JSON.stringify(shown));
	});

	test("a denial sends nothing to the provider and surfaces as a denial", async () => {
		gate.setHandler(() => ({ type: "deny", code: "refused", message: "429 usage limit, try again later" }));

		const failure = await requestOpenAiRemoteCompaction(openAiModel(), "secret-key", compactInput, "compact it").then(
			() => undefined,
			(error: unknown) => error,
		);

		expect(AIError.isModelRequestDenied(failure)).toBe(true);
		expect(seen).toHaveLength(0);
		expect(gate.attempts).toHaveLength(1);
	});

	test("a caller-supplied fetch is still authorized before it sends", async () => {
		const sent: string[] = [];
		gate.setHandler(() => ({ type: "deny", code: "refused", message: "no" }));

		const failure = await requestOpenAiRemoteCompaction(
			openAiModel(),
			"secret-key",
			compactInput,
			"compact it",
			undefined,
			{
				fetch: async input => {
					sent.push(String(input));
					return Response.json({ output: [] });
				},
			},
		).then(
			() => undefined,
			(error: unknown) => error,
		);

		expect(AIError.isModelRequestDenied(failure)).toBe(true);
		expect(sent).toEqual([]);
	});
});

describe("requestRemoteCompaction on behalf of a model", () => {
	test("is authorized as a chat attempt of that model before it reaches the endpoint", async () => {
		const summary = await requestRemoteCompaction(
			`http://127.0.0.1:${server.port}/v1/chat/completions`,
			{ systemPrompt: "system", prompt: "summarize", maxTokens: 100 },
			undefined,
			{ model: openAiModel(), apiKey: "secret-key" },
		);

		expect(summary.summary).toBe("summary");
		expect(gate.attempts.map(attempt => [attempt.kind, attempt.model.id])).toEqual([["chat", "gpt-loopback"]]);
		expect(gate.attempts[0].wire?.method).toBe("POST");
		expect(seen.map(request => request.path)).toEqual(["/v1/chat/completions"]);
	});

	test("a denial sends nothing to the endpoint", async () => {
		gate.setHandler(() => ({ type: "deny", code: "refused", message: "no" }));

		const failure = await requestRemoteCompaction(
			`http://127.0.0.1:${server.port}/v1/chat/completions`,
			{ systemPrompt: "system", prompt: "summarize", maxTokens: 100 },
			undefined,
			{ model: openAiModel(), apiKey: "secret-key" },
		).then(
			() => undefined,
			(error: unknown) => error,
		);

		expect(AIError.isModelRequestDenied(failure)).toBe(true);
		expect(seen).toHaveLength(0);
	});
});
