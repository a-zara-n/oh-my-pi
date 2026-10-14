/**
 * Per call site of the model-request inventory: a request issued from that site through the real code path, with a
 * bundled-catalog model whose endpoint is a 127.0.0.1 fake provider, reaches the registered gate as a wire attempt
 * carrying the owning session's scope and the site's purpose, and the loopback receives exactly the attempts the gate
 * permitted. With the gate denying, the loopback sees nothing and the site surfaces the denial.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import * as path from "node:path";
import {
	type Api,
	type AssistantMessage,
	type Context,
	completeSimple,
	type Model,
	streamSimple,
} from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { generateTextReviewContextSummary } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/annotate/text-summary";
import * as legacyPiAi from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-ai-shim";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SpeechEnhancer } from "@oh-my-pi/pi-coding-agent/tts/speech-enhancer";
import { installFixtureGate, recordingLease } from "../../ai/test/helpers/model-request-gate-fixture";
import {
	type LoopbackResponder,
	openAIResponsesTextReply,
	replyBody,
	scripted,
} from "../../ai/test/helpers/model-request-loopback";
import { type CacheWarmingRefreshEnd, getCacheWarmingDelayMs } from "../src/session/cache-warmer";
import {
	anthropicTextReplyWithPrompt,
	DENIAL_CODE,
	DENIAL_MESSAGE,
	type ExpectedSiteScope,
	expectDeniedSiteAttempt,
	expectPermittedSiteAttempts,
	jsonReply,
	type LoopbackFlavor,
	nextSessionEvent,
	type ObservedTimers,
	observeTimersWithDelay,
	openAIResponsesToolCallReply,
	type SessionLoopback,
	sessionIdOf,
	startSessionLoopback,
} from "./helpers/model-request-session-loopback";
import { assistantMsg, userMsg } from "./utilities";

const gate = installFixtureGate();

const ROOT_AGENT_ID = "RootAgent";
const REPLY_TEXT = "loopback reply";

/** Registers per-test loopback setup in the enclosing `describe`; the current harness is `.current`. */
function useLoopback(flavor: LoopbackFlavor, responder: LoopbackResponder): { readonly current: SessionLoopback } {
	let harness: SessionLoopback | undefined;
	beforeEach(async () => {
		gate.reset();
		harness = await startSessionLoopback(responder, flavor);
	});
	afterEach(async () => {
		await harness?.dispose();
		harness = undefined;
		gate.reset();
	});
	return {
		get current(): SessionLoopback {
			if (harness === undefined) throw new Error("the loopback is only available inside a test");
			return harness;
		},
	};
}

function rootScope(
	sessionId: string,
	purpose: ExpectedSiteScope["purpose"],
	reason?: ExpectedSiteScope["reason"],
): ExpectedSiteScope {
	return {
		sessionId,
		rootSessionId: sessionId,
		purpose,
		agent: { kind: "main", id: ROOT_AGENT_ID },
		...(reason === undefined ? {} : { reason }),
	};
}

describe("S-10 sdk.ts session stream functions", () => {
	const lb = useLoopback("openai-responses", scripted(openAIResponsesTextReply(REPLY_TEXT)));

	it("S-10 main agent loop prompt: one wire attempt, purpose main, the session as its own root", async () => {
		const loopback = lb.current;
		loopback.permit(gate);
		const session = await loopback.createSession({ agentId: ROOT_AGENT_ID, cacheWarming: false });

		await session.prompt("hello");
		await session.waitForIdle();

		expectPermittedSiteAttempts(gate, loopback, rootScope(sessionIdOf(session), "main"), 1);
	});

	it("S-10 main agent loop prompt denied: the gate is asked once, nothing is sent, the denial surfaces", async () => {
		const loopback = lb.current;
		loopback.deny(gate);
		const session = await loopback.createSession({ agentId: ROOT_AGENT_ID, cacheWarming: false });

		await session.prompt("hello");
		await session.waitForIdle();

		expectDeniedSiteAttempt(gate, loopback, rootScope(sessionIdOf(session), "main"));
		const last = session.messages.at(-1);
		expect(last?.role).toBe("assistant");
		expect(last?.role === "assistant" ? last.errorMessage : undefined).toContain(DENIAL_MESSAGE);
	});

	it("S-10 child session created with modelRequestRoot: purpose subagent, root is the parent", async () => {
		const loopback = lb.current;
		loopback.permit(gate);
		const parent = await loopback.createSession({ agentId: ROOT_AGENT_ID, cacheWarming: false });
		const child = await loopback.createSession({
			agentId: "ChildAgent",
			taskDepth: 1,
			modelRequestRoot: parent.childModelRequestRoot(),
			cacheWarming: false,
		});

		await child.prompt("work");
		await child.waitForIdle();

		expect(sessionIdOf(child)).not.toBe(sessionIdOf(parent));
		expectPermittedSiteAttempts(
			gate,
			loopback,
			{
				sessionId: sessionIdOf(child),
				rootSessionId: sessionIdOf(parent),
				purpose: "subagent",
				agent: { kind: "sub", id: "ChildAgent" },
			},
			1,
		);
	});

	it("S-10 lease protocol: beginSend precedes the loopback, chunks concatenate to the consumed body, one response-ended settle", async () => {
		const loopback = lb.current;
		const recorded = recordingLease(loopback.trace);
		gate.setHandler(() => {
			loopback.trace.push("gate");
			return { type: "allow", lease: recorded.lease };
		});
		const session = await loopback.createSession({ agentId: ROOT_AGENT_ID, cacheWarming: false });

		await session.prompt("hello");
		await session.waitForIdle();
		await recorded.firstSettle;

		expect(gate.attempts).toHaveLength(1);
		expect(loopback.provider.requests).toHaveLength(1);
		expect(loopback.trace).toEqual(["gate", "beginSend", "loopback-request", "observeResponse", "settle"]);
		expect(recorded.events[0]).toEqual({ type: "beginSend" });
		expect(Buffer.from(recorded.observedBytes()).toString("utf8")).toBe(
			replyBody(openAIResponsesTextReply(REPLY_TEXT)),
		);
		expect(recorded.settled).toEqual([{ type: "response-ended", status: 200 }]);
		const reply = session.messages.at(-1);
		expect(reply?.role === "assistant" ? reply.content : undefined).toEqual([
			expect.objectContaining({ type: "text", text: REPLY_TEXT }),
		]);
	});
});

describe("S-11 cache-warmer.ts cache warm-up replay", () => {
	/** A prompt this large makes a refresh worth its cost even in the idle phase. */
	const PROMPT_TOKENS = 100_000;
	const lb = useLoopback("anthropic-messages", scripted(anthropicTextReplyWithPrompt(REPLY_TEXT, PROMPT_TOKENS)));
	let observed: ObservedTimers | undefined;

	afterEach(() => {
		observed?.restore();
		observed = undefined;
	});

	interface Replay {
		readonly sessionId: string;
		readonly outcome: CacheWarmingRefreshEnd["outcome"];
	}

	/**
	 * Run one real turn, then fire the warm-up timer it armed (instead of sleeping for it) and wait for the
	 * refresh the warmer sends.
	 */
	async function replayAfterRealTurn(): Promise<Replay> {
		const loopback = lb.current;
		const shortLifetimeSeconds = loopback.model.promptCache?.short;
		const delayMs =
			shortLifetimeSeconds === undefined ? undefined : getCacheWarmingDelayMs(shortLifetimeSeconds * 1000);
		if (delayMs === undefined) throw new Error("Expected the model to declare a short prompt-cache lifetime");
		const session = await loopback.createSession({
			agentId: ROOT_AGENT_ID,
			settings: { "providers.cacheWarming": "idle" },
		});
		observed = observeTimersWithDelay(delayMs);
		await session.prompt("hello");
		await session.waitForIdle();
		const armed = observed.pending();
		expect(armed).toHaveLength(1);
		expect(session.cacheWarmingStatus).toMatchObject({ state: "scheduled" });
		const ended = nextSessionEvent(session, "cache_warming_end");
		armed[0]?.();
		return { sessionId: sessionIdOf(session), outcome: (await ended).outcome };
	}

	it("S-11 cache warmer replay: a second wire attempt, purpose cache-warm, reason replay, the session as its own root", async () => {
		const loopback = lb.current;
		loopback.permit(gate);

		const { sessionId } = await replayAfterRealTurn();

		expect(gate.attempts[0]?.scope?.purpose).toBe("main");
		expectPermittedSiteAttempts(gate, loopback, rootScope(sessionId, "cache-warm", "replay"), 1, { leading: 1 });
	});

	it("S-11 cache warmer replay denied: the gate is asked once for the replay, nothing is sent, the refresh ends in error", async () => {
		const loopback = lb.current;
		// The real turn passes; only the replay is refused.
		gate.setHandler(attempt => {
			loopback.trace.push("gate");
			return attempt.scope?.purpose === "cache-warm"
				? { type: "deny", code: DENIAL_CODE, message: DENIAL_MESSAGE }
				: { type: "pass" };
		});

		const { sessionId, outcome } = await replayAfterRealTurn();

		expect(outcome).toBe("error");
		expectDeniedSiteAttempt(gate, loopback, rootScope(sessionId, "cache-warm", "replay"), { leading: 1 });
	});
});

/** Replies the compaction endpoint with a compaction item and every other path with a streamed text answer. */
function compactionAwareResponder(): LoopbackResponder {
	const answer = openAIResponsesTextReply(REPLY_TEXT);
	const compacted = jsonReply({ output: [{ type: "compaction", encrypted_content: "opaque-compaction-item" }] });
	return request => (request.target.endsWith("/responses/compact") ? compacted : answer);
}

/**
 * Three question/answer pairs appended to both the live agent and the persisted session, long enough that
 * `compaction.keepRecentTokens` below cuts at a turn boundary (one history summary, no split-turn prefix summary).
 * Returns the persisted entry ids in order.
 */
function seedConversation(session: AgentSession): string[] {
	const entryIds: string[] = [];
	for (const [question, answer] of [
		["first question ".repeat(15), "first answer ".repeat(15)],
		["second question ".repeat(15), "second answer ".repeat(15)],
		["third question ".repeat(15), "third answer ".repeat(15)],
	] as const) {
		const user = userMsg(question);
		const assistant = assistantMsg(answer);
		session.agent.appendMessage(user);
		entryIds.push(session.sessionManager.appendMessage(user));
		session.agent.appendMessage(assistant);
		entryIds.push(session.sessionManager.appendMessage(assistant));
	}
	return entryIds;
}

/** Makes `compaction.keepRecentTokens` cut `seedConversation`'s history at a turn boundary. */
const COMPACTION_SETTINGS = { "compaction.keepRecentTokens": 120 } as const;

describe("S-12 session maintenance and side requests", () => {
	const lb = useLoopback("openai-responses", compactionAwareResponder());

	it("S-12 manual /compact with the local summary method: purpose compaction", async () => {
		const loopback = lb.current;
		loopback.permit(gate);
		const session = await loopback.createSession({
			agentId: ROOT_AGENT_ID,
			settings: { ...COMPACTION_SETTINGS, "compaction.methodOrder": ["soft"] },
		});
		seedConversation(session);

		await session.compact(undefined, { suppressContinuation: true });

		// The summary, then the short summary: two separate requests, each its own first attempt.
		expectPermittedSiteAttempts(gate, loopback, rootScope(sessionIdOf(session), "compaction"), 2);
	});

	it("S-12 manual /compact with the local summary method denied: the gate is asked once, nothing is sent, the denial surfaces", async () => {
		const loopback = lb.current;
		loopback.deny(gate);
		const session = await loopback.createSession({
			agentId: ROOT_AGENT_ID,
			settings: { ...COMPACTION_SETTINGS, "compaction.methodOrder": ["soft"] },
		});
		seedConversation(session);

		await expect(session.compact(undefined, { suppressContinuation: true })).rejects.toThrow(DENIAL_MESSAGE);

		expectDeniedSiteAttempt(gate, loopback, rootScope(sessionIdOf(session), "compaction"));
	});

	it("S-12 native remote compaction: the /responses/compact request is a gated wire attempt, purpose compaction", async () => {
		const loopback = lb.current;
		loopback.permit(gate);
		const session = await loopback.createSession({
			agentId: ROOT_AGENT_ID,
			settings: { ...COMPACTION_SETTINGS, "compaction.methodOrder": ["remote"] },
		});
		seedConversation(session);

		await session.compact(undefined, { suppressContinuation: true });

		expect(loopback.provider.requests.map(request => request.target)).toEqual(["/v1/responses/compact"]);
		expectPermittedSiteAttempts(gate, loopback, rootScope(sessionIdOf(session), "compaction"), 1);
	});

	it("S-12 native remote compaction denied: the gate is asked once, nothing is sent, the denial surfaces", async () => {
		const loopback = lb.current;
		loopback.deny(gate);
		const session = await loopback.createSession({
			agentId: ROOT_AGENT_ID,
			settings: { ...COMPACTION_SETTINGS, "compaction.methodOrder": ["remote"] },
		});
		seedConversation(session);

		await expect(session.compact(undefined, { suppressContinuation: true })).rejects.toThrow(DENIAL_MESSAGE);

		expectDeniedSiteAttempt(gate, loopback, rootScope(sessionIdOf(session), "compaction"));
	});
});

describe("S-12 branch summary, handoff, advisor and side-channel requests", () => {
	const lb = useLoopback("openai-responses", scripted(openAIResponsesTextReply(REPLY_TEXT)));

	it("S-12 branch summary (navigateTree with summarize): purpose branch-summary", async () => {
		const loopback = lb.current;
		loopback.permit(gate);
		const session = await loopback.createSession({ agentId: ROOT_AGENT_ID });
		const entryIds = seedConversation(session);

		const navigated = await session.navigateTree(entryIds[1]!, { summarize: true });

		expect(navigated.cancelled).toBe(false);
		expectPermittedSiteAttempts(gate, loopback, rootScope(sessionIdOf(session), "branch-summary"), 1);
	});

	it("S-12 branch summary denied: the gate is asked once, nothing is sent, the denial surfaces", async () => {
		const loopback = lb.current;
		loopback.deny(gate);
		const session = await loopback.createSession({ agentId: ROOT_AGENT_ID });
		const entryIds = seedConversation(session);

		await expect(session.navigateTree(entryIds[1]!, { summarize: true })).rejects.toThrow(DENIAL_MESSAGE);

		expectDeniedSiteAttempt(gate, loopback, rootScope(sessionIdOf(session), "branch-summary"));
	});

	it("S-12 handoff: purpose handoff, requested under the session that asked for it", async () => {
		const loopback = lb.current;
		loopback.permit(gate);
		const session = await loopback.createSession({ agentId: ROOT_AGENT_ID, settings: COMPACTION_SETTINGS });
		seedConversation(session);
		const sessionId = sessionIdOf(session);

		await session.handoff();

		expectPermittedSiteAttempts(gate, loopback, rootScope(sessionId, "handoff"), 1);
	});

	it("S-12 handoff denied: the gate is asked once, nothing is sent, the denial surfaces", async () => {
		const loopback = lb.current;
		loopback.deny(gate);
		const session = await loopback.createSession({ agentId: ROOT_AGENT_ID, settings: COMPACTION_SETTINGS });
		seedConversation(session);

		await expect(session.handoff()).rejects.toThrow(DENIAL_MESSAGE);

		expectDeniedSiteAttempt(gate, loopback, rootScope(sessionIdOf(session), "handoff"));
	});

	it("S-12 advisor request: purpose advisor, an advisor sub-agent of the session, root is the session", async () => {
		const loopback = lb.current;
		loopback.permit(gate);
		const session = await loopback.createSession({ agentId: ROOT_AGENT_ID });
		session.settings.setModelRole("advisor", `${loopback.model.provider}/${loopback.model.id}`);
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected the advisor agent to be live");

		await advisor.prompt("review the change");

		expectPermittedSiteAttempts(
			gate,
			loopback,
			{
				sessionId: sessionIdOf(session),
				rootSessionId: sessionIdOf(session),
				purpose: "advisor",
				agent: { kind: "sub", id: "advisor" },
			},
			1,
		);
	});

	it("S-12 advisor request denied: the gate is asked once, nothing is sent, the denial surfaces", async () => {
		const loopback = lb.current;
		loopback.deny(gate);
		const session = await loopback.createSession({ agentId: ROOT_AGENT_ID });
		session.settings.setModelRole("advisor", `${loopback.model.provider}/${loopback.model.id}`);
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected the advisor agent to be live");

		await advisor.prompt("review the change");

		expectDeniedSiteAttempt(gate, loopback, {
			sessionId: sessionIdOf(session),
			rootSessionId: sessionIdOf(session),
			purpose: "advisor",
			agent: { kind: "sub", id: "advisor" },
		});
		const last = advisor.state.messages.at(-1);
		expect(last?.role === "assistant" ? last.errorMessage : undefined).toContain(DENIAL_MESSAGE);
	});

	it("S-12 side-channel ephemeral turn: purpose side-channel", async () => {
		const loopback = lb.current;
		loopback.permit(gate);
		const session = await loopback.createSession({ agentId: ROOT_AGENT_ID, cacheWarming: false });
		await session.prompt("hello");
		await session.waitForIdle();

		const result = await session.runEphemeralTurn({ promptText: "Where are we?" });

		expect(result).toBeDefined();
		expect(gate.attempts[0]?.scope?.purpose).toBe("main");
		expectPermittedSiteAttempts(gate, loopback, rootScope(sessionIdOf(session), "side-channel"), 1, { leading: 1 });
	});

	it("S-12 side-channel ephemeral turn denied: the gate is asked once for the side turn, nothing is sent, the denial surfaces", async () => {
		const loopback = lb.current;
		loopback.permit(gate);
		const session = await loopback.createSession({ agentId: ROOT_AGENT_ID, cacheWarming: false });
		await session.prompt("hello");
		await session.waitForIdle();
		// Only the side turn is refused; the real turn above already passed.
		gate.setHandler(attempt => {
			loopback.trace.push("gate");
			return attempt.scope?.purpose === "side-channel"
				? { type: "deny", code: DENIAL_CODE, message: DENIAL_MESSAGE }
				: { type: "pass" };
		});

		await expect(session.runEphemeralTurn({ promptText: "Where are we?" })).rejects.toThrow(DENIAL_MESSAGE);

		expectDeniedSiteAttempt(gate, loopback, rootScope(sessionIdOf(session), "side-channel"), { leading: 1 });
	});
});

describe("S-15 title-generator.ts title generation", () => {
	const lb = useLoopback("openai-responses", scripted(openAIResponsesTextReply("<title>Fix login redirect</title>")));
	const FIRST_MESSAGE = "Fix the failing login redirect in the auth middleware";

	it("S-15 title generation: purpose title, one wire attempt under the session", async () => {
		const loopback = lb.current;
		loopback.permit(gate);
		const session = await loopback.createSession({ agentId: ROOT_AGENT_ID });

		const title = await session.generateTitle(FIRST_MESSAGE);

		expect(title).toBe("Fix login redirect");
		expectPermittedSiteAttempts(gate, loopback, rootScope(sessionIdOf(session), "title"), 1);
	});

	it("S-15 title generation denied: the gate is asked once, nothing is sent, no title is produced", async () => {
		const loopback = lb.current;
		loopback.deny(gate);
		const session = await loopback.createSession({ agentId: ROOT_AGENT_ID });

		const title = await session.generateTitle(FIRST_MESSAGE);

		expect(title).toBeNull();
		expectDeniedSiteAttempt(gate, loopback, rootScope(sessionIdOf(session), "title"));
	});
});

describe("S-16 edit/auto-repair.ts auto-repair", () => {
	const SOURCE = "export function alpha(a: number): number {\n\treturn a + 1;\n}\n";
	const REPAIRED_BODY = "export function alpha(a: number): number {\n\treturn (a + 1);\n}";
	const lb = useLoopback(
		"openai-responses",
		scripted(
			// 1: the model's edit call, 2: the repair model's candidate, 3: the model's answer after the tool result.
			openAIResponsesToolCallReply("edit", {
				path: "sample.ts",
				old_string: "return a + 1;",
				new_string: "return (a + 1;",
			}),
			openAIResponsesTextReply(REPAIRED_BODY),
			openAIResponsesTextReply(REPLY_TEXT),
		),
	);

	/** A turn whose edit breaks the file's parse, so the edit tool asks for an auto-repair. */
	async function editThatBreaksParse(): Promise<{ readonly sessionId: string; readonly source: string }> {
		const loopback = lb.current;
		await Bun.write(path.join(loopback.tempDir.path(), "sample.ts"), SOURCE);
		const session = await loopback.createSession({
			agentId: ROOT_AGENT_ID,
			cacheWarming: false,
			settings: { "edit.mode": "replace", "edit.autoRepair.enabled": true },
		});
		// Auto-repair asks the smol role's model.
		session.settings.setModelRole("smol", `${loopback.model.provider}/${loopback.model.id}`);
		await session.prompt("break the file");
		await session.waitForIdle();
		return {
			sessionId: sessionIdOf(session),
			source: await Bun.file(path.join(loopback.tempDir.path(), "sample.ts")).text(),
		};
	}

	it("S-16 auto-repair: the repair request is a gated wire attempt between the turn's two requests, purpose auto-repair", async () => {
		const loopback = lb.current;
		loopback.permit(gate);

		const { sessionId, source } = await editThatBreaksParse();

		expect(gate.attempts.map(attempt => attempt.scope?.purpose)).toEqual(["main", "auto-repair", "main"]);
		expectPermittedSiteAttempts(gate, loopback, rootScope(sessionId, "auto-repair"), 1, { leading: 1, trailing: 1 });
		expect(source.trim()).toBe(REPAIRED_BODY);
	});

	it("S-16 auto-repair denied: the repair is asked once, nothing is sent for it, the broken edit stays", async () => {
		const loopback = lb.current;
		gate.setHandler(attempt => {
			loopback.trace.push("gate");
			return attempt.scope?.purpose === "auto-repair"
				? { type: "deny", code: DENIAL_CODE, message: DENIAL_MESSAGE }
				: { type: "pass" };
		});

		const { sessionId, source } = await editThatBreaksParse();

		expectDeniedSiteAttempt(gate, loopback, rootScope(sessionId, "auto-repair"), { leading: 1, trailing: 1 });
		expect(source).toContain("return (a + 1;");
	});
});

describe("S-17 memory: auto-learn capture", () => {
	const lb = useLoopback("openai-responses", scripted(openAIResponsesTextReply(REPLY_TEXT)));
	const CAPTURE: Context = { messages: [{ role: "user", content: "capture this", timestamp: 1 }] };

	it("S-17 auto-learn capture issuing completeSimple: purpose memory, one wire attempt under the session", async () => {
		const loopback = lb.current;
		loopback.permit(gate);
		const session = await loopback.createSession({ agentId: ROOT_AGENT_ID, cacheWarming: false });
		let captured: AssistantMessage | undefined;

		await session.runAutolearnCapture(async () => {
			captured = await completeSimple(loopback.model, CAPTURE, { apiKey: "capture-key" });
		});

		expect(captured?.stopReason).toBe("stop");
		expectPermittedSiteAttempts(gate, loopback, rootScope(sessionIdOf(session), "memory"), 1);
	});

	it("S-17 auto-learn capture denied: the gate is asked once, nothing is sent, the completion resolves as a denial", async () => {
		const loopback = lb.current;
		loopback.deny(gate);
		const session = await loopback.createSession({ agentId: ROOT_AGENT_ID, cacheWarming: false });
		let captured: AssistantMessage | undefined;

		await session.runAutolearnCapture(async () => {
			captured = await completeSimple(loopback.model, CAPTURE, { apiKey: "capture-key" });
		});

		expect(AIError.isModelRequestDenied(captured)).toBe(true);
		expectDeniedSiteAttempt(gate, loopback, rootScope(sessionIdOf(session), "memory"));
	});
});

describe("S-20 extension-called streamSimple", () => {
	const lb = useLoopback("openai-responses", scripted(openAIResponsesTextReply(REPLY_TEXT)));
	const ASK: Context = { messages: [{ role: "user", content: "extension question", timestamp: 1 }] };

	/** An extension whose `agent_start` handler asks the model through `ask`, before the turn's own request. */
	function askingExtension(ask: (model: Model<Api>) => Promise<void>, model: Model<Api>): ExtensionFactory {
		return pi => {
			pi.on("agent_start", async () => {
				await ask(model);
			});
		};
	}

	it("S-20 handler calling pi-ai streamSimple: a wire attempt of the owning session, its own root", async () => {
		const loopback = lb.current;
		loopback.permit(gate);
		const session = await loopback.createSession({
			agentId: ROOT_AGENT_ID,
			cacheWarming: false,
			extensions: [
				askingExtension(async model => {
					await streamSimple(model, ASK, { apiKey: "extension-key" }).result();
				}, loopback.model),
			],
		});

		await session.prompt("hello");
		await session.waitForIdle();

		expect(gate.attempts.map(attempt => attempt.scope?.purpose)).toEqual(["main", "main"]);
		expectPermittedSiteAttempts(gate, loopback, rootScope(sessionIdOf(session), "main"), 2);
	});

	it("S-20 handler calling the legacy pi-ai shim's streamSimple: a wire attempt of the owning session, its own root", async () => {
		const loopback = lb.current;
		loopback.permit(gate);
		const session = await loopback.createSession({
			agentId: ROOT_AGENT_ID,
			cacheWarming: false,
			extensions: [
				askingExtension(async model => {
					await legacyPiAi.streamSimple(model, ASK, { apiKey: "extension-key" }).result();
				}, loopback.model),
			],
		});

		await session.prompt("hello");
		await session.waitForIdle();

		expectPermittedSiteAttempts(gate, loopback, rootScope(sessionIdOf(session), "main"), 2);
	});

	it("S-20 child session handler: the request names the child as its session and the parent as its root", async () => {
		const loopback = lb.current;
		loopback.permit(gate);
		const parent = await loopback.createSession({ agentId: ROOT_AGENT_ID, cacheWarming: false });
		const child = await loopback.createSession({
			agentId: "ChildAgent",
			taskDepth: 1,
			modelRequestRoot: parent.childModelRequestRoot(),
			cacheWarming: false,
			extensions: [
				askingExtension(async model => {
					await streamSimple(model, ASK, { apiKey: "extension-key" }).result();
				}, loopback.model),
			],
		});

		await child.prompt("work");
		await child.waitForIdle();

		expectPermittedSiteAttempts(
			gate,
			loopback,
			{
				sessionId: sessionIdOf(child),
				rootSessionId: sessionIdOf(parent),
				purpose: "subagent",
				agent: { kind: "sub", id: "ChildAgent" },
			},
			2,
		);
	});

	it("S-20 handler request denied: the gate is asked once for it, nothing is sent for it, the extension sees the denial", async () => {
		const loopback = lb.current;
		loopback.permit(gate);
		let seen: AssistantMessage | undefined;
		const session = await loopback.createSession({
			agentId: ROOT_AGENT_ID,
			cacheWarming: false,
			extensions: [
				askingExtension(async model => {
					seen = await streamSimple(model, ASK, { apiKey: "extension-key" }).result();
				}, loopback.model),
			],
		});
		let asked = 0;
		// The extension's request comes first and is refused; the turn's own request that follows passes.
		gate.setHandler(() => {
			loopback.trace.push("gate");
			asked += 1;
			return asked === 1 ? { type: "deny", code: DENIAL_CODE, message: DENIAL_MESSAGE } : { type: "pass" };
		});

		await session.prompt("hello");
		await session.waitForIdle();

		expect(AIError.isModelRequestDenied(seen)).toBe(true);
		expectDeniedSiteAttempt(gate, loopback, rootScope(sessionIdOf(session), "main"), { trailing: 1 });
	});
});

describe("S-18 speech enhancement and annotation", () => {
	const lb = useLoopback("openai-responses", scripted(openAIResponsesTextReply("spoken form")));

	/** Speech and annotation requests are only ever made for a session that has just run a turn; this is that turn. */
	async function runTurn(session: AgentSession): Promise<void> {
		await session.prompt("hello");
		await session.waitForIdle();
	}

	it("S-18 speech enhancement started from a session event listener: purpose speech-enhance, the listener's session", async () => {
		const loopback = lb.current;
		loopback.permit(gate);
		const session = await loopback.createSession({ agentId: ROOT_AGENT_ID, cacheWarming: false });
		const enhancer = new SpeechEnhancer({
			settings: session.settings,
			registry: loopback.modelRegistry,
			sessionId: sessionIdOf(session),
		});
		// The interactive event controller reaches the enhancer from a `session.subscribe` listener.
		const rewritten = Promise.withResolvers<string | null>();
		session.subscribe(event => {
			if (event.type === "agent_end")
				enhancer.rewrite("A paragraph to be spoken.").then(rewritten.resolve, rewritten.reject);
		});

		await runTurn(session);

		expect(await rewritten.promise).toBe("spoken form");
		expectPermittedSiteAttempts(gate, loopback, rootScope(sessionIdOf(session), "speech-enhance"), 1, { leading: 1 });
	});

	it("S-18 speech enhancement denied: the gate is asked once for it, nothing is sent, the caller falls back (null)", async () => {
		const loopback = lb.current;
		const session = await loopback.createSession({ agentId: ROOT_AGENT_ID, cacheWarming: false });
		gate.setHandler(attempt => {
			loopback.trace.push("gate");
			return attempt.scope?.purpose === "speech-enhance"
				? { type: "deny", code: DENIAL_CODE, message: DENIAL_MESSAGE }
				: { type: "pass" };
		});
		const enhancer = new SpeechEnhancer({
			settings: session.settings,
			registry: loopback.modelRegistry,
			sessionId: sessionIdOf(session),
		});
		const rewritten = Promise.withResolvers<string | null>();
		session.subscribe(event => {
			if (event.type === "agent_end")
				enhancer.rewrite("A paragraph to be spoken.").then(rewritten.resolve, rewritten.reject);
		});

		await runTurn(session);

		expect(await rewritten.promise).toBeNull();
		expectDeniedSiteAttempt(gate, loopback, rootScope(sessionIdOf(session), "speech-enhance"), { leading: 1 });
	});

	it("S-18 speech enhancement called outside any session: the gate is told the origin is unclassified, with no scope", async () => {
		const loopback = lb.current;
		loopback.permit(gate);
		const session = await loopback.createSession({ agentId: ROOT_AGENT_ID, cacheWarming: false });
		const enhancer = new SpeechEnhancer({
			settings: session.settings,
			registry: loopback.modelRegistry,
			sessionId: sessionIdOf(session),
		});

		await enhancer.rewrite("A paragraph to be spoken.");

		expect(gate.attempts).toHaveLength(1);
		expect(gate.attempts[0]?.origin).toBe("unclassified");
		expect(gate.attempts[0]?.scope).toBeUndefined();
		expect(loopback.provider.requests).toHaveLength(1);
	});

	/**
	 * The annotate command is a custom command, which cannot be injected into a session that has extension discovery
	 * disabled. An extension command is dispatched from the same place (`session.prompt`), so the annotate summary
	 * function is called from one, with the session model the annotate command reads off its context.
	 */
	function annotateSummaryCommand(model: Model<Api>): ExtensionFactory {
		return pi => {
			pi.registerCommand("annotate-summary", {
				handler: async (_args, ctx) => {
					await generateTextReviewContextSummary(
						{ model, modelRegistry: ctx.modelRegistry, sessionManager: ctx.sessionManager },
						"A long source text to be rephrased.",
					);
				},
			});
		};
	}

	it("S-18 annotate source summary run from a slash command: purpose annotate, the owning session", async () => {
		const loopback = lb.current;
		loopback.permit(gate);
		const session = await loopback.createSession({
			agentId: ROOT_AGENT_ID,
			cacheWarming: false,
			extensions: [annotateSummaryCommand(loopback.model)],
		});

		await session.prompt("/annotate-summary");
		await session.waitForIdle();

		expectPermittedSiteAttempts(gate, loopback, rootScope(sessionIdOf(session), "annotate"), 1);
	});

	it("S-18 annotate source summary denied: the gate is asked once, nothing is sent, no summary is produced", async () => {
		const loopback = lb.current;
		loopback.deny(gate);
		const session = await loopback.createSession({
			agentId: ROOT_AGENT_ID,
			cacheWarming: false,
			extensions: [annotateSummaryCommand(loopback.model)],
		});

		await session.prompt("/annotate-summary");
		await session.waitForIdle();

		expectDeniedSiteAttempt(gate, loopback, rootScope(sessionIdOf(session), "annotate"));
	});
});
