/**
 * A one-shot helper that walks a list of models tells the model-request gate that every model it asks after the first
 * is a `model-fallback` of the previous attempt, and stops at a denial instead of asking the next model. The provider
 * is a loopback server reached through the real transport; the gate is the shared fixture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { generateCommitMessage } from "@oh-my-pi/pi-coding-agent/utils/commit-message-generator";
import { installFixtureGate } from "../../ai/test/helpers/model-request-gate-fixture";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const gate = installFixtureGate();

const PROVIDER = "loopback-walk";
const DIFF = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";

let server: Bun.Server<undefined>;
let respond: (modelId: string | undefined) => Response;
const seenModels: Array<string | undefined> = [];

function rejected(): Response {
	return new Response(JSON.stringify({ error: { message: "bad request" } }), {
		status: 400,
		headers: { "content-type": "application/json" },
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

function chatModel(id: string): Model<Api> {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: PROVIDER,
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8000,
		maxTokens: 1000,
	});
}

function walkOf(models: Model<Api>[]): { settings: Settings; registry: ModelRegistry } {
	const settings = Settings.isolated({ modelRoles: { smol: `${models[0].provider}/${models[0].id}` } });
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime(PROVIDER, "loopback-key");
	const registry = new ModelRegistry(authStorage, "/nonexistent/model-request-fallback-walk.yml");
	vi.spyOn(registry, "getAvailable").mockReturnValue(models);
	return { settings, registry };
}

beforeEach(() => {
	gate.reset();
	seenModels.length = 0;
	respond = () => chatAnswer("fix: update a");
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as { model?: string };
			seenModels.push(body.model);
			return respond(body.model);
		},
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	await server.stop(true);
	gate.reset();
});

describe("commit message generation and the model-request gate", () => {
	it("tells the gate the second model asked is a model-fallback of the first model's failed attempt", async () => {
		const first = chatModel("commit-first");
		const second = chatModel("commit-second");
		respond = model => (model === first.id ? rejected() : chatAnswer("fix: update a"));
		const { settings, registry } = walkOf([first, second]);

		const message = await generateCommitMessage(DIFF, registry, settings);

		expect(message).toBe("fix: update a");
		expect(seenModels).toEqual([first.id, second.id]);
		expect(gate.attempts.map(attempt => [attempt.reason, attempt.model.id])).toEqual([
			["first", first.id],
			["model-fallback", second.id],
		]);
		expect(gate.attempts[1].retryOf).toBe(gate.attempts[0].attemptId);
	});

	it("stops at a denied first model: nothing is sent and the second model is never asked", async () => {
		const first = chatModel("commit-denied");
		const second = chatModel("commit-never-asked");
		gate.setHandler(() => ({ type: "deny", code: "refused", message: "503 overloaded, try again" }));
		const { settings, registry } = walkOf([first, second]);

		const message = await generateCommitMessage(DIFF, registry, settings);

		expect(message).toBeNull();
		expect(seenModels).toHaveLength(0);
		expect(gate.attempts.map(attempt => attempt.model.id)).toEqual([first.id]);
	});
});
