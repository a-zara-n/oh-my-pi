import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai";
import { markModelRequestLocalStream } from "@oh-my-pi/pi-ai/model-request-execution";
import { complete, completeSimple, stream, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Api, AssistantMessage, Model, Usage } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { installFixtureGate } from "./helpers/model-request-gate-fixture";
import { helloContext } from "./helpers/model-request-loopback";

/**
 * An on-device transport is exempt from the model request gate only for the function that was declared local. Another
 * function registered under the same API name, or a separately supplied `stream` next to a local `streamSimple`, is an
 * ordinary custom API and asks the gate once.
 */

const gate = installFixtureGate();

const API = "loopback-local-api";
const SOURCE = "model-request-local-exemption-test";

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** A transport that answers at once and counts how often it was started. */
function transport(): { readonly start: (model: Model<Api>) => AssistantMessageEventStream; readonly started: () => number } {
	let count = 0;
	return {
		start(model) {
			count += 1;
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "on-device answer" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				timestamp: 1,
				stopReason: "stop",
				usage: emptyUsage(),
			};
			const events = new AssistantMessageEventStream();
			events.push({ type: "start", partial: message });
			events.push({ type: "done", reason: "stop", message });
			return events;
		},
		started: () => count,
	};
}

const MODEL: Model<Api> = buildModel({
	id: "local-model",
	name: "Local model",
	api: API,
	provider: "loopback-local",
	baseUrl: "http://127.0.0.1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 1_000,
});

const ENTRIES: ReadonlyArray<{ readonly name: string; readonly run: () => Promise<unknown> }> = [
	{ name: "stream", run: () => stream(MODEL, helloContext(), { apiKey: "k" }).result() },
	{ name: "complete", run: () => complete(MODEL, helloContext(), { apiKey: "k" }) },
	{ name: "streamSimple", run: () => streamSimple(MODEL, helloContext(), { apiKey: "k" }).result() },
	{ name: "completeSimple", run: () => completeSimple(MODEL, helloContext(), { apiKey: "k" }) },
];

beforeEach(() => {
	gate.reset();
});

afterEach(() => {
	gate.reset();
	unregisterCustomApis(SOURCE);
});

describe("a custom API declared on-device", () => {
	for (const entry of ENTRIES) {
		test(`${entry.name}: its declared function runs without asking the gate`, async () => {
			const local = transport();
			markModelRequestLocalStream(local.start);
			registerCustomApi(API, local.start, SOURCE);

			await entry.run();

			expect(local.started()).toBe(1);
			expect(gate.attempts).toHaveLength(0);
		});

		test(`${entry.name}: another function registered under the same API name is not exempt`, async () => {
			const local = transport();
			markModelRequestLocalStream(local.start);
			registerCustomApi(API, local.start, SOURCE);
			unregisterCustomApis(SOURCE);
			const other = transport();
			registerCustomApi(API, other.start, SOURCE);

			await entry.run();

			expect(other.started()).toBe(1);
			expect(gate.attempts).toHaveLength(1);
			expect(gate.attempts[0]?.wire).toBeUndefined();
		});
	}

	test("a local streamSimple next to a separately supplied stream is exempt only through streamSimple", async () => {
		const local = transport();
		const separate = transport();
		markModelRequestLocalStream(local.start);
		registerCustomApi(API, local.start, SOURCE, separate.start);

		await streamSimple(MODEL, helloContext(), { apiKey: "k" }).result();
		expect(local.started()).toBe(1);
		expect(gate.attempts).toHaveLength(0);

		await stream(MODEL, helloContext(), { apiKey: "k" }).result();
		expect(separate.started()).toBe(1);
		expect(gate.attempts).toHaveLength(1);
		expect(gate.attempts[0]?.wire).toBeUndefined();
	});

	test("declaring both functions local exempts every entry", async () => {
		const simple = transport();
		const full = transport();
		markModelRequestLocalStream(simple.start);
		markModelRequestLocalStream(full.start);
		registerCustomApi(API, simple.start, SOURCE, full.start);

		await stream(MODEL, helloContext(), { apiKey: "k" }).result();
		await streamSimple(MODEL, helloContext(), { apiKey: "k" }).result();

		expect(full.started()).toBe(1);
		expect(simple.started()).toBe(1);
		expect(gate.attempts).toHaveLength(0);
	});
});
