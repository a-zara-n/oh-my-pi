import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, AssistantMessage, ChoiceQuestion, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ChainJudge } from "@oh-my-pi/pi-coding-agent/judgment";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/**
 * A denied judge request must surface as a stop. Falling through to the next candidate would
 * ask the same gate again under another model, and its wording ("429 usage limit") says nothing
 * about whether another candidate is worth trying.
 */

const bundledOnline = getBundledModel("anthropic", "claude-sonnet-4-6");
if (!bundledOnline) throw new Error("Expected bundled online judge model");
const ONLINE: Model<Api> = bundledOnline;
const ONLINE_BACKUP = { ...ONLINE, id: "claude-sonnet-judge-backup", name: "Judge Backup" } as Model<Api>;

const TIER_QUESTION: ChoiceQuestion<"low" | "high"> = {
	type: "choice",
	instructions: "Choose the reasoning tier.",
	criteria: { low: "simple", high: "complex" },
};

const LOOKALIKE_TEXT = "429 usage limit reached, rate limit exceeded, 503 overloaded";

function makeChain(): { settings: Settings; registry: ModelRegistry } {
	const settings = Settings.isolated({
		modelRoles: { judge: `${ONLINE.provider}/${ONLINE.id}` },
		"retry.fallbackChains": { judge: [`${ONLINE_BACKUP.provider}/${ONLINE_BACKUP.id}`] },
	});
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime(ONLINE.provider, "online-key");
	const registry = new ModelRegistry(authStorage, "/nonexistent/judgment-chain-denial-models.yml");
	vi.spyOn(registry, "getAvailable").mockReturnValue([ONLINE, ONLINE_BACKUP]);
	return { settings, registry };
}

async function deniedReply(model: Model<Api>): Promise<AssistantMessage> {
	const flattened = await AIError.finalize(new AIError.ModelRequestDeniedError("gate_refused", LOOKALIKE_TEXT), {
		api: model.api,
	});
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: flattened.stopReason,
		errorId: flattened.id,
		errorStatus: flattened.status,
		errorMessage: flattened.message,
		timestamp: Date.now(),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ChainJudge with a denied request", () => {
	it("asks only the first chat candidate when its completion is denied", async () => {
		const { settings, registry } = makeChain();
		const attempted: string[] = [];
		vi.spyOn(ai, "completeSimple").mockImplementation(async model => {
			attempted.push(model.id);
			return deniedReply(model);
		});

		const failure = await new ChainJudge({ settings, registry, purpose: "test", sessionModel: ONLINE })
			.judge({ state: "rename a local", questions: { level: TIER_QUESTION } })
			.catch((error: unknown) => error);

		expect(AIError.isModelRequestDenied(failure)).toBe(true);
		expect(attempted).toEqual([ONLINE.id]);
	});

	it("rethrows the denial from the first candidate without invoking the second", async () => {
		const { settings, registry } = makeChain();
		const denied = new AIError.ModelRequestDeniedError("gate_refused", LOOKALIKE_TEXT);
		let candidatesTried = 0;

		await expect(
			new ChainJudge({ settings, registry, purpose: "test", sessionModel: ONLINE }).withCandidate(async () => {
				candidatesTried += 1;
				throw denied;
			}),
		).rejects.toBe(denied);

		expect(candidatesTried).toBe(1);
	});

	it("still tries the second candidate when the first fails with the same wording but no denial", async () => {
		const { settings, registry } = makeChain();
		let candidatesTried = 0;

		const answer = await new ChainJudge({ settings, registry, purpose: "test", sessionModel: ONLINE }).withCandidate(
			async () => {
				candidatesTried += 1;
				if (candidatesTried === 1) throw new Error(LOOKALIKE_TEXT);
				return "second";
			},
		);

		expect(answer).toBe("second");
		expect(candidatesTried).toBe(2);
	});
});
