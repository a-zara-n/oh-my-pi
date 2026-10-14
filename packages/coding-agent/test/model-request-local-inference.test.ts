/**
 * The on-device local-inference transport sends nothing off the machine, so it is exempt from the model-request gate:
 * a gate that refuses every request neither sees nor blocks it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { completeSimple } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { registerLocalInferenceApi } from "@oh-my-pi/pi-coding-agent/tiny/local-inference-api";
import { tinyModelClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import { installFixtureGate } from "../../ai/test/helpers/model-request-gate-fixture";

const gate = installFixtureGate();
const SOURCE_ID = "omp/local-inference";
const local = getBundledModel("local", "lfm2.5-230m");
if (!local) throw new Error("Expected the bundled on-device model");

describe("local inference and the model-request gate", () => {
	beforeEach(() => {
		gate.reset();
		registerLocalInferenceApi();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		unregisterCustomApis(SOURCE_ID);
		gate.reset();
	});

	it("completes on-device while the gate refuses everything, without asking the gate", async () => {
		gate.setHandler(() => ({ type: "deny", code: "refused", message: "refused" }));
		vi.spyOn(tinyModelClient, "chat").mockResolvedValue("local answer");

		const result = await completeSimple(local, { messages: [{ role: "user", content: "question", timestamp: 1 }] });

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "local answer" }]);
		expect(gate.attempts).toHaveLength(0);
	});
});
