import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { ModelRequestDeniedError, type ModelRequestModelRef } from "@oh-my-pi/pi-ai/model-request-gate";
import { stream } from "@oh-my-pi/pi-ai/stream";
import type { FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { gateFetch } from "@oh-my-pi/pi-ai/utils/model-request-fetch";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL, serializeCloudflareAiGatewayCredential } from "@oh-my-pi/pi-catalog/wire/cloudflare-ai-gateway";
import { fetchWithRetry } from "@oh-my-pi/pi-utils";
import { installFixtureGate, recordingLease } from "./helpers/model-request-gate-fixture";
import { scripted, startLoopbackProvider } from "./helpers/model-request-loopback";

/**
 * What the gate is told about an attempt and what happens when the gate itself fails: the model it is shown is the one
 * the request is actually addressed to, a base URL that carries a credential is redacted like the wire, and a gate
 * whose `beginSend` throws leaves nothing sent, no lease unsettled, and nothing a retry layer would replay.
 */

const gate = installFixtureGate();

beforeEach(() => {
	gate.reset();
});

afterEach(() => {
	gate.reset();
});

describe("the model an attempt names", () => {
	test("is shown with credentials in its base URL redacted, like the wire url", async () => {
		const reference: ModelRequestModelRef = {
			provider: "loopback",
			id: "m",
			api: "loopback-api",
			baseUrl: "https://user:hunter2@proxy.invalid/v1?api_key=abc&region=eu#frag",
		};
		const fetch = gateFetch(reference, "chat", async () => new Response("ok"));

		await (await fetch("https://proxy.invalid/v1/x", { method: "POST", body: "{}" })).text();

		expect(gate.attempts).toHaveLength(1);
		expect(gate.attempts[0]?.model.baseUrl).toBe("https://proxy.invalid/v1?region=eu");
		expect(JSON.stringify(gate.attempts[0])).not.toContain("hunter2");
		expect(JSON.stringify(gate.attempts[0])).not.toContain("api_key=abc");
	});

	test("is the model the provider definition rewrote the request to, not the model the transport was first built for", async () => {
		const requested: Model = buildModel({
			id: "openai/gpt-5.4",
			name: "GPT-5.4",
			api: "anthropic-messages",
			provider: "cloudflare-ai-gateway",
			baseUrl: CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL,
			reasoning: false,
			input: ["text"],
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
			contextWindow: 200_000,
			maxTokens: 64_000,
		});
		const sentTo: string[] = [];
		const capture: FetchImpl = Object.assign(
			async (input: string | URL | Request) => {
				sentTo.push(String(input instanceof Request ? input.url : input));
				return Response.json({ error: { message: "captured" } }, { status: 400 });
			},
			{ preconnect: fetch.preconnect },
		);
		const credential = serializeCloudflareAiGatewayCredential("gateway-token", "account-id", "my-gateway");

		await stream(
			requested,
			{ messages: [{ role: "user", content: "Say hello", timestamp: 0 }] },
			{ apiKey: credential, fetch: capture, maxTokens: 16 },
		).result();

		expect(requested.api).toBe("anthropic-messages");
		expect(gate.attempts).toHaveLength(1);
		const attempt = gate.attempts[0]!;
		expect(attempt.model.api).toBe("openai-completions");
		expect(attempt.model.baseUrl).toBe("https://gateway.ai.cloudflare.com/v1/account-id/my-gateway/openai");
		expect(attempt.wire?.url).toBe("https://gateway.ai.cloudflare.com/v1/account-id/my-gateway/openai/chat/completions");
		expect(sentTo).toEqual(["https://gateway.ai.cloudflare.com/v1/account-id/my-gateway/openai/chat/completions"]);
	});
});

describe("a gate that fails while the send starts", () => {
	test("is a terminal gate-error: nothing is sent, the lease is released as not-sent once, and a retry layer does not replay it", async () => {
		const loopback = startLoopbackProvider(scripted({ status: 200, chunks: ["ok"] }));
		try {
			const record = recordingLease();
			gate.setHandler(async () => ({
				type: "allow",
				lease: {
					...record.lease,
					beginSend() {
						throw new Error("gate bookkeeping failed");
					},
				},
			}));
			const fetch = gateFetch({ provider: "loopback", id: "m", api: "loopback-api" }, "chat", (input, init) =>
				globalThis.fetch(input, init),
			);

			const error = await fetchWithRetry(`${loopback.origin}/x`, {
				method: "POST",
				body: "{}",
				fetch,
				maxAttempts: 3,
				defaultDelayMs: () => 1,
				maxDelayMs: 1,
			}).then(
				() => undefined,
				(thrown: unknown) => thrown,
			);

			expect(error).toBeInstanceOf(ModelRequestDeniedError);
			expect(error instanceof ModelRequestDeniedError ? error.code : undefined).toBe("gate-error");
			expect(AIError.isModelRequestDenied(error)).toBe(true);
			expect(gate.attempts).toHaveLength(1);
			expect(loopback.requests).toHaveLength(0);
			expect(record.settled).toEqual([{ type: "not-sent", aborted: false }]);
		} finally {
			loopback.stop();
		}
	});
});
