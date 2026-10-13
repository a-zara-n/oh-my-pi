import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model, Usage } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	type RecoveryCompactionResult,
	TurnRecovery,
	type TurnRecoveryHost,
} from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * A model-request denial ends the turn. The denial's wording is the gate's own and can read
 * like a transient 429, so recovery must key off the structured flag: no automatic retry, no
 * credential/backoff cycle, and no switch to a fallback-chain model.
 */

const USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const LOOKALIKE_TEXT = "429 usage limit reached: rate limit exceeded, timeout, 503 overloaded";

interface RecoveryObservations {
	modelSwitches: string[];
	events: string[];
	continues: number;
}

function createHost(
	model: Model,
	modelRegistry: ModelRegistry,
	fallbackChains: Record<string, string[]>,
	observed: RecoveryObservations,
): TurnRecoveryHost {
	const settings = Settings.isolated({ "retry.fallbackChains": fallbackChains });
	const agentState = { messages: [] as never[] };
	return {
		agent: {
			state: agentState,
			replaceMessages() {},
		} as never,
		sessionManager: {
			getLastModelChangeRole: () => undefined,
			getSessionId: () => "denial-session",
			appendModelChange: (selector: string) => observed.modelSwitches.push(selector),
		} as never,
		persistedAssistantEntryId: () => undefined,
		settings,
		modelRegistry,
		configWarnings: [],
		model: () => model,
		contextFitsModel: () => true,
		textOutputCommitted: () => true,
		thinkingLevel: () => undefined,
		configuredThinkingLevel: () => undefined,
		setThinkingLevel: () => {},
		thinkingLevelCeiling: () => undefined,
		isDisposed: () => false,
		isStreaming: () => false,
		isCompacting: () => false,
		abortInProgress: () => false,
		streamingEditAbortTriggered: () => false,
		promptGeneration: () => 0,
		promptSequence: () => 0,
		sessionId: () => "test-session",
		emitSessionEvent: async event => {
			observed.events.push(event.type);
		},
		scheduleAgentContinue: () => {
			observed.continues += 1;
		},
		waitForSessionMessagePersistence: async () => {},
		appendSessionMessage: () => {},
		sessionMessageAlreadyPersisted: () => false,
		setModelWithProviderSessionReset: async next => {
			observed.modelSwitches.push(`${next.provider}/${next.id}`);
		},
		resolveActiveEditMode: () => "hashline",
		syncAfterModelChange: async () => {},
		resetCurrentResponsesProviderSession: () => {},
		maybeAutoRedeemReset: async () => ({ restored: false }),
		runAutoCompaction: async () => ({ continuationScheduled: false }) as RecoveryCompactionResult,
		shakeForRequestBodyReadTimeout: async () => false,
		withBashBranchTransition: <T>(operation: () => T): T => operation(),
	};
}

describe("TurnRecovery with a denied request", () => {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model claude-sonnet-4-5");
	const fallbackChains = { [`${model.provider}/${model.id}`]: ["openai/gpt-4o-mini"] };

	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-turn-recovery-denial-");
		authStorage = await AuthStorage.create(tempDir.join("testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		authStorage.keys.setRuntime("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"), { settings: Settings.isolated() });
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	const failedTurn = (errorId?: number): AssistantMessage => {
		return {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { ...USAGE },
			stopReason: "error",
			errorMessage: LOOKALIKE_TEXT,
			errorId,
			timestamp: Date.now(),
		};
	};

	const deniedTurn = async (): Promise<AssistantMessage> => {
		const flattened = await AIError.finalize(new AIError.ModelRequestDeniedError("gate_refused", LOOKALIKE_TEXT), {
			api: model.api,
		});
		return { ...failedTurn(flattened.id), errorStatus: flattened.status, errorMessage: flattened.message };
	};

	it("stops the turn with no automatic retry, no fallback eligibility, and no model switch", async () => {
		const observed: RecoveryObservations = { modelSwitches: [], events: [], continues: 0 };
		const recovery = new TurnRecovery(createHost(model, modelRegistry, fallbackChains, observed));
		const denied = await deniedTurn();

		expect(recovery.isRetryableError(denied)).toBe(false);
		expect(recovery.isHardErrorFallbackEligible(denied)).toBe(false);
		await expect(
			recovery.handleRetryableError(denied, { allowModelFallback: true, hardErrorFallback: true }),
		).resolves.toBe(false);

		expect(observed).toEqual({ modelSwitches: [], events: [], continues: 0 });
	});

	it("treats the same wording as retryable and fallback-eligible when it is not a denial", () => {
		const observed: RecoveryObservations = { modelSwitches: [], events: [], continues: 0 };
		const recovery = new TurnRecovery(createHost(model, modelRegistry, fallbackChains, observed));
		const ordinary = failedTurn();

		expect(recovery.isRetryableError(ordinary)).toBe(true);
		expect(recovery.isHardErrorFallbackEligible(ordinary)).toBe(true);
	});
});
