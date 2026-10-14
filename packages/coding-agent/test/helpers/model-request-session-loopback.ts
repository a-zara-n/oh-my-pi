import { expect, vi } from "bun:test";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ModelRequestAttempt, ModelRequestPurpose } from "@oh-my-pi/pi-ai/model-request-gate";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { ModelRequestRootAssignment } from "@oh-my-pi/pi-coding-agent/session/model-request-context";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { FixtureGate } from "../../../ai/test/helpers/model-request-gate-fixture";
import {
	type LoopbackProvider,
	type LoopbackReply,
	type LoopbackResponder,
	sseReply,
	startLoopbackProvider,
} from "../../../ai/test/helpers/model-request-loopback";
import { createInMemoryAuthStorage } from "./agent-session-setup";

/**
 * A real `AgentSession` whose bundled-catalog model (`openai-responses` or `anthropic-messages`) talks to a fake
 * provider on 127.0.0.1.
 *
 * The registry's provider is re-pointed at the loopback through a `models.yml` override, so every bundled model of
 * it keeps its catalog identity and compat and every request any role resolves lands on the loopback. Nothing here
 * reaches the network, Keychain or the user's configuration.
 */

export type LoopbackFlavor = "openai-responses" | "anthropic-messages";

interface FlavorSpec {
	readonly provider: string;
	readonly basePath: string;
}

const FLAVORS: Record<LoopbackFlavor, FlavorSpec> = {
	"openai-responses": { provider: "openai", basePath: "/v1" },
	"anthropic-messages": { provider: "anthropic", basePath: "" },
};

const CREDENTIAL = "loopback-session-credential";

/** Settings every session of this harness starts with; `Settings.isolated` overrides are merged over them. */
const BASE_SETTINGS = { "compaction.enabled": false, "providers.openaiWebsockets": "off" } as const;

export interface LoopbackSessionInit {
	readonly agentId: string;
	readonly taskDepth?: number;
	readonly modelRequestRoot?: ModelRequestRootAssignment;
	/** Overrides merged over the harness's base settings. */
	readonly settings?: Readonly<Record<string, unknown>>;
	/** Whether the session keeps its prompt-cache warmer (default: it does). */
	readonly cacheWarming?: boolean;
	readonly extensions?: readonly ExtensionFactory[];
}

export interface SessionLoopback {
	readonly provider: LoopbackProvider;
	/** Gate decisions and loopback arrivals in the order they happened: `"gate"` and `"loopback-request"`. */
	readonly trace: string[];
	/** A bundled model of the harness's flavor whose endpoint is the loopback. */
	readonly model: Model<Api>;
	readonly modelRegistry: ModelRegistry;
	readonly authStorage: AuthStorage;
	readonly tempDir: TempDir;
	createSession(init: LoopbackSessionInit): Promise<AgentSession>;
	/** Make the shared fixture gate answer `pass` and note each attempt in {@link SessionLoopback.trace}. */
	permit(gate: FixtureGate): void;
	/** Make the shared fixture gate deny every attempt and note each in {@link SessionLoopback.trace}. */
	deny(gate: FixtureGate): void;
	dispose(): Promise<void>;
}

/** The text a gate denial carries; a test looks for it in the error the operation surfaces. */
export const DENIAL_CODE = "site-send-denied";
export const DENIAL_MESSAGE = "site send test denial";

export async function startSessionLoopback(
	responder: LoopbackResponder,
	flavor: LoopbackFlavor = "openai-responses",
): Promise<SessionLoopback> {
	const spec = FLAVORS[flavor];
	const trace: string[] = [];
	const provider = startLoopbackProvider(responder, { trace });
	const tempDir = TempDir.createSync("@pi-site-sends-");
	await Bun.write(
		path.join(tempDir.path(), "models.yml"),
		JSON.stringify({ providers: { [spec.provider]: { baseUrl: `${provider.origin}${spec.basePath}` } } }),
	);
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime(spec.provider, CREDENTIAL);
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	// The prompt-cache warmer only arms for a model that declares a cache lifetime. Among the Anthropic models that do
	// and have no reasoning (so a replay is always safe), the one with the dearest input: a refresh then pays off
	// even for a prompt that fits its context window.
	const bundled = modelRegistry
		.getAll("chat")
		.filter(
			candidate =>
				candidate.provider === spec.provider &&
				candidate.api === flavor &&
				(flavor !== "anthropic-messages" || (candidate.promptCache !== undefined && !candidate.reasoning)),
		)
		.sort(
			(a, b) => (flavor === "anthropic-messages" ? b.cost.input - a.cost.input : 0) || a.id.localeCompare(b.id),
		)[0];
	if (!bundled) throw new Error(`Expected a bundled ${flavor} model in the catalog`);
	if (!bundled.baseUrl?.startsWith(provider.origin)) {
		throw new Error(
			`Expected the models.yml override to point ${bundled.id} at the loopback, got ${bundled.baseUrl}`,
		);
	}
	const model: Model<Api> = bundled;
	const sessions: AgentSession[] = [];

	return {
		provider,
		trace,
		model,
		modelRegistry,
		authStorage,
		tempDir,
		async createSession(init) {
			const settings = Settings.isolated({ ...BASE_SETTINGS, ...init.settings });
			const { session } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: SessionManager.inMemory(tempDir.path()),
				agentRegistry: new AgentRegistry(),
				authStorage,
				modelRegistry,
				settings,
				model,
				extensions: init.extensions === undefined ? [] : [...init.extensions],
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				agentId: init.agentId,
				taskDepth: init.taskDepth,
				modelRequestRoot: init.modelRequestRoot,
				cacheWarming: init.cacheWarming,
			});
			sessions.push(session);
			return session;
		},
		permit(gate) {
			gate.setHandler(() => {
				trace.push("gate");
				return { type: "pass" };
			});
		},
		deny(gate) {
			gate.setHandler(() => {
				trace.push("gate");
				return { type: "deny", code: DENIAL_CODE, message: DENIAL_MESSAGE };
			});
		},
		async dispose() {
			for (const session of sessions.splice(0)) await session.dispose();
			provider.stop();
			authStorage.close();
			tempDir.removeSync();
		},
	};
}

export function sessionIdOf(session: AgentSession): string {
	return session.sessionManager.getSessionId();
}

/** What a gate must have been told about every attempt of one site. */
export interface ExpectedSiteScope {
	readonly sessionId: string;
	readonly rootSessionId: string;
	readonly purpose: ModelRequestPurpose;
	readonly agent: { readonly kind: "main" | "sub"; readonly id: string };
	readonly reason?: ModelRequestAttempt["reason"];
}

function header(headers: Readonly<Record<string, string>>, name: string): string | undefined {
	return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

/** Permitted requests of other sites that happen before and after the site under test; the gate and loopback see them too. */
export interface SurroundingRequests {
	readonly leading?: number;
	readonly trailing?: number;
}

function expectAttemptOfSite(attempt: ModelRequestAttempt | undefined, expected: ExpectedSiteScope): void {
	expect(attempt?.origin).toBe("session");
	expect(attempt?.kind).toBe("chat");
	expect(attempt?.reason).toBe(expected.reason ?? "first");
	expect(attempt?.scope).toMatchObject({
		sessionId: expected.sessionId,
		rootSessionId: expected.rootSessionId,
		purpose: expected.purpose,
		agent: { kind: expected.agent.kind, id: expected.agent.id },
	});
}

/**
 * The site's contract, asserted from what the gate saw and what the loopback received: `count` attempts between the
 * `surrounding` ones that belong to other sites, each a session-origin chat request with the expected scope and a
 * credential-free POST wire, every gate decision made before the request it permitted arrived, and the loopback
 * having received exactly the attempts the gate permitted.
 */
export function expectPermittedSiteAttempts(
	gate: FixtureGate,
	loopback: SessionLoopback,
	expected: ExpectedSiteScope,
	count: number,
	surrounding: SurroundingRequests = {},
): void {
	const leading = surrounding.leading ?? 0;
	const total = leading + count + (surrounding.trailing ?? 0);
	expect(gate.attempts).toHaveLength(total);
	expect(loopback.provider.requests).toHaveLength(total);
	for (const attempt of gate.attempts.slice(leading, leading + count)) {
		expectAttemptOfSite(attempt, expected);
		expect(attempt.wire?.method).toBe("POST");
		expect(attempt.wire?.url.startsWith(loopback.provider.origin)).toBe(true);
		expect(header(attempt.wire?.headers ?? {}, "authorization")).toBeUndefined();
		expect(header(attempt.wire?.headers ?? {}, "x-api-key")).toBeUndefined();
		expect(attempt.wire?.bodyBytes).toBeGreaterThan(0);
	}
	expect(new Set(gate.attempts.map(attempt => attempt.attemptId)).size).toBe(total);
	// No prefix of the trace has more arrivals than gate decisions.
	let decisions = 0;
	let arrivals = 0;
	for (const event of loopback.trace) {
		if (event === "gate") decisions += 1;
		else arrivals += 1;
		expect(arrivals).toBeLessThanOrEqual(decisions);
	}
	expect(decisions).toBe(total);
	expect(arrivals).toBe(total);
}

/**
 * A denied site: between the `surrounding` permitted requests of other sites the gate was asked exactly once, with
 * the expected scope, and that attempt never reached the loopback.
 */
export function expectDeniedSiteAttempt(
	gate: FixtureGate,
	loopback: SessionLoopback,
	expected: ExpectedSiteScope,
	surrounding: SurroundingRequests = {},
): void {
	const leading = surrounding.leading ?? 0;
	const trailing = surrounding.trailing ?? 0;
	expect(gate.attempts).toHaveLength(leading + 1 + trailing);
	expect(loopback.provider.requests).toHaveLength(leading + trailing);
	const pair = ["gate", "loopback-request"];
	expect(loopback.trace).toEqual([
		...Array.from({ length: leading }, () => pair).flat(),
		"gate",
		...Array.from({ length: trailing }, () => pair).flat(),
	]);
	expectAttemptOfSite(gate.attempts[leading], expected);
}

/** Resolves with the next session event of `type`; subscribe before triggering the work that emits it. */
export function nextSessionEvent<TType extends AgentSessionEvent["type"]>(
	session: AgentSession,
	type: TType,
): Promise<Extract<AgentSessionEvent, { type: TType }>> {
	type Matching = Extract<AgentSessionEvent, { type: TType }>;
	const isMatching = (event: AgentSessionEvent): event is Matching => event.type === type;
	const next = Promise.withResolvers<Matching>();
	const unsubscribe = session.subscribe(event => {
		if (!isMatching(event)) return;
		unsubscribe();
		next.resolve(event);
	});
	return next.promise;
}

/** An Anthropic Messages answer whose `message_start` usage reports a prompt of `promptTokens` tokens. */
export function anthropicTextReplyWithPrompt(text: string, promptTokens: number): LoopbackReply {
	return sseReply(
		[
			{
				type: "message_start",
				message: {
					id: "msg_loopback",
					type: "message",
					role: "assistant",
					model: "claude-loopback",
					content: [],
					usage: { input_tokens: promptTokens, output_tokens: 0 },
				},
			},
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
			{ type: "message_stop" },
		],
		{ eventNames: true },
	);
}

/** A 200 JSON body reply, for endpoints that do not stream. */
export function jsonReply(body: unknown): LoopbackReply {
	return { status: 200, headers: { "content-type": "application/json" }, chunks: [JSON.stringify(body)] };
}

/** Timers armed with one particular delay, observed so a test can fire them on demand; see {@link observeTimersWithDelay}. */
export interface ObservedTimers {
	/** Callbacks of the timers armed with the observed delay and not cleared since, in arming order. */
	pending(): Array<() => void>;
	/** Stop observing. */
	restore(): void;
}

/**
 * Watch every timer armed with exactly `delayMs`, so a test can fire its callback itself instead of sleeping for the
 * delay (the real, unreferenced timer stays armed and is cleared by its owner as usual). Both `setTimeout` and
 * `clearTimeout` still run for real.
 */
export function observeTimersWithDelay(delayMs: number): ObservedTimers {
	const setSpy = vi.spyOn(globalThis, "setTimeout");
	const clearSpy = vi.spyOn(globalThis, "clearTimeout");
	return {
		pending() {
			const cleared: unknown[] = clearSpy.mock.calls.map(([handle]) => handle);
			return setSpy.mock.calls.flatMap(([handler, timeout, ...args], index) => {
				const handle = setSpy.mock.results[index]?.value;
				if (timeout !== delayMs || typeof handler !== "function" || cleared.includes(handle)) return [];
				return [() => handler(...args)];
			});
		},
		restore() {
			setSpy.mockRestore();
			clearSpy.mockRestore();
		},
	};
}

/** An OpenAI Responses answer that is one function call, so the session runs the tool and sends another request. */
export function openAIResponsesToolCallReply(name: string, args: Readonly<Record<string, unknown>>): LoopbackReply {
	const argumentsJson = JSON.stringify(args);
	const item = { type: "function_call", id: "fc_loopback", call_id: "call_loopback", name, arguments: argumentsJson };
	return sseReply([
		{ type: "response.created", response: { id: "resp_loopback" } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
		{ type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_loopback", delta: argumentsJson },
		{
			type: "response.function_call_arguments.done",
			output_index: 0,
			item_id: "fc_loopback",
			arguments: argumentsJson,
		},
		{ type: "response.output_item.done", output_index: 0, item: { ...item, status: "completed" } },
		{
			type: "response.completed",
			response: {
				id: "resp_loopback",
				status: "completed",
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	]);
}
