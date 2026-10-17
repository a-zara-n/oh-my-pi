/** Canonical provider-neutral model and message data. */
export type KnownApi =
	| "openai-completions"
	| "openai-responses"
	| "openrouter"
	| "openai-codex-responses"
	| "azure-openai-responses"
	| "anthropic-messages"
	| "bedrock-converse-stream"
	| "google-generative-ai"
	| "google-gemini-cli"
	| "google-vertex"
	| "ollama-chat"
	| "cursor-agent"
	| "factory-droid-agent"
	| "gitlab-duo-agent"
	| "devin-agent"
	| "apple-foundation-models";
export type Api = KnownApi | (string & {});
// `Provider` is any provider-id string; `KnownProvider` (re-exported above) enumerates
// the built-in model providers from the catalog descriptor table.
export type Provider = string;
export interface Usage {
	/** Non-cached conversation input tokens (matches the bucket the provider bills as new input). */
	input: number;
	/** Total conversation output tokens for the turn, including thinking, assistant text, and tool-call argument tokens. */
	output: number;
	/** Conversation tokens read from the prompt cache. */
	cacheRead: number;
	/** Conversation tokens written to the prompt cache (cache creation). */
	cacheWrite: number;
	/** Sum of input + output + cacheRead + cacheWrite plus provider-side orchestration tokens when reported. */
	totalTokens: number;
	/** Provider-reported occupied context tokens when the value is authoritative but not a billable input/output bucket. */
	contextTokens?: number;
	/** Provider-side orchestration tokens, billed but not part of the conversation prompt/cache buckets. */
	orchestration?: {
		/** Non-cached orchestration input tokens. */
		input?: number;
		/** Orchestration tokens read from provider-side cache. */
		cacheRead?: number;
		/** Orchestration output tokens. */
		output?: number;
	};
	/** Copilot premium-request counter, when applicable. */
	premiumRequests?: number;
	/**
	 * Reasoning/thinking tokens included in `output`, when the provider reports them
	 * (OpenAI `output_tokens_details.reasoning_tokens`, Google `thoughtsTokenCount`).
	 * Always a subset of `output` — non-reasoning output is `output - reasoningTokens`.
	 *
	 * Providers that don't expose this leave it undefined rather than guessing;
	 * `undefined` means unknown, NOT zero.
	 */
	reasoningTokens?: number;
	/**
	 * Cache-write TTL breakdown (Anthropic only). When set, the components sum to
	 * `cacheWrite`. Absent providers do not populate this.
	 */
	cttl?: {
		ephemeral5m?: number;
		ephemeral1h?: number;
	};
	/**
	 * Server-side tool invocations made during this turn (Anthropic web_search /
	 * web_fetch, OpenAI built-in tools when reported). Counts requests, not tokens.
	 */
	server?: {
		webSearch?: number;
		webFetch?: number;
	};
	/** Provider-reported credit meter values for credit-based billing APIs. */
	credits?: {
		/** Uncommitted per-response credit cost, when reported. */
		cost?: number;
		/** Final committed credit cost, when reported. */
		committedCost?: number;
		/** Final committed ACU cost, when reported. */
		acuCost?: number;
	};
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}
export type MessageAttribution = "user" | "agent";
/**
 * Service tier hint for processing priority / cost control. These are the
 * values providers consume on the wire:
 *
 * - OpenAI / OpenAI-Codex: sent verbatim as the `service_tier` field
 *   (`flex`/`scale`/`priority`/`ultrafast`). `ultrafast` is a separate
 *   low-latency serving path: sent to the OpenAI API as-is (preview access is
 *   per project), and to Codex only for models whose discovery advertises it.
 * - Google (Gemini API + Vertex AI): sent as the top-level `serviceTier`
 *   field (`flex`/`priority`).
 * - OpenRouter: passed through as `service_tier`; OpenRouter realizes it for
 *   the OpenAI- and Google-family upstreams it supports and ignores it
 *   otherwise.
 * - Direct Anthropic: `"priority"` is translated into `speed: "fast"` plus the
 *   fast-mode beta on supported Opus models. Other tiers are ignored.
 *
 * Per-family scoping is expressed by {@link ServiceTierByFamily}, not by
 * scoped sentinel values — see {@link serviceTierFamily}.
 */
export type ServiceTier = "auto" | "default" | "flex" | "scale" | "priority" | "ultrafast";

/** Provider families that expose an independent service-tier knob. */
export type ServiceTierFamily = "openai" | "anthropic" | "google";

/**
 * Per-family service-tier selection. A request consults only the entry for the
 * family its model belongs to (see {@link resolveModelServiceTier}), so a user
 * can opt one family into priority without affecting the others when switching
 * models mid-session.
 */
export type ServiceTierByFamily = Partial<Record<ServiceTierFamily, ServiceTier>>;
/** Stores streamed tool-call argument JSON for live renderers and parser recovery. */
export const kStreamingPartialJson = Symbol("provider.block.partialJson");

/** Carries streamed tool-call argument JSON without exposing a string-keyed property. */
export type StreamingPartialJsonCarrier = object & { [kStreamingPartialJson]?: string };

/** Reads streamed tool-call argument JSON from a block or event snapshot. */
export function getStreamingPartialJson(block: StreamingPartialJsonCarrier | null | undefined): string | undefined {
	return block?.[kStreamingPartialJson];
}

/** Writes streamed tool-call argument JSON to a block or clears it with `undefined`. */
export function setStreamingPartialJson(block: StreamingPartialJsonCarrier, value: string | undefined): void {
	block[kStreamingPartialJson] = value;
}

/** Clears streamed tool-call argument JSON without deleting or changing object shape. */
export function clearStreamingPartialJson(block: StreamingPartialJsonCarrier): void {
	if (Object.hasOwn(block, kStreamingPartialJson)) block[kStreamingPartialJson] = undefined;
}
export type StopDetails = {
	type: string;
	category?: string | null;
	explanation?: string | null;
	fallback_credit_token?: string | null;
	fallback_has_prefill_claim?: boolean | null;
};
export interface TextSignatureV1 {
	v: 1;
	id: string;
	phase?: "commentary" | "final_answer";
}

export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string; // e.g., for OpenAI responses, message metadata (legacy id string or TextSignatureV1 JSON)
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string; // e.g., for OpenAI responses, the reasoning item ID
	itemId?: string; // item.id from output_item.added, used to match output_item.done
}

export interface RedactedThinkingContent {
	type: "redactedThinking";
	data: string;
}

/**
 * Anthropic server-side-fallback boundary marker persisted on assistant
 * turns whose provider request opted into
 * `AnthropicOptions.fallbacks`. Consumers other than the Anthropic
 * provider MUST ignore it — `transformMessages` strips the block on any
 * cross-provider hop and on non-official Anthropic replays, so downstream
 * converters never see it.
 */
export interface AnthropicFallbackContent {
	type: "fallback";
	from: { model: string };
	to: { model: string };
}

/**
 * Verbatim Anthropic web-search or tool-search call/result retained for
 * same-provider history replay. Other providers discard it in
 * `transformMessages`.
 */
export interface AnthropicServerToolContent {
	type: "anthropicServerTool";
	block:
		| {
				type: "server_tool_use";
				id: string;
				name: "web_search" | "tool_search_tool_regex" | "tool_search_tool_bm25";
				input?: Record<string, unknown> | null;
				[key: string]: unknown;
		  }
		| {
				type: "web_search_tool_result" | "tool_search_tool_result";
				tool_use_id: string;
				content: unknown;
				[key: string]: unknown;
		  };
}

/** Provider-native uploaded file reference for image reuse without retransmitting bytes. */
export interface ProviderFileReference {
	provider: "openai" | "anthropic" | "google";
	id?: string;
	uri?: string;
	expiresAt?: number;
}

export interface ImageContent {
	type: "image";
	data: string; // base64 encoded image data
	mimeType: string; // e.g., "image/jpeg", "image/png"
	/**
	 * OpenAI-only resolution hint. `"original"` preserves native resolution
	 * (required for snapcompact frames, whose glyphs do not survive the
	 * default `auto` downscale). Providers without a detail knob ignore it.
	 */
	detail?: "auto" | "low" | "high" | "original";
	/** Provider-native file reference preferred only by its matching provider. */
	providerFile?: ProviderFileReference;
	/**
	 * Optional https mirror of `data`, served by a caller-run blob server.
	 * Providers whose API fetches remote images send this URL instead of the
	 * base64 payload; every other provider ignores it. `data` remains the
	 * source of truth — the URL must serve exactly those bytes, and callers
	 * are responsible for keeping it stable across turns (prefix caches hash
	 * the URL string, and Anthropic silently forgets images when a resent
	 * turn differs byte-wise).
	 */
	url?: string;
}

export type ComputerAction =
	| {
			type: "click";
			button: "left" | "right" | "wheel" | "back" | "forward";
			x: number;
			y: number;
			keys?: string[] | null;
	  }
	| { type: "double_click"; x: number; y: number; keys: string[] | null }
	| { type: "drag"; path: Array<{ x: number; y: number }>; keys?: string[] | null }
	| { type: "keypress"; keys: string[] }
	| { type: "move"; x: number; y: number; keys?: string[] | null }
	| { type: "screenshot" }
	| { type: "scroll"; x: number; y: number; scroll_x: number; scroll_y: number; keys?: string[] | null }
	| { type: "type"; text: string }
	| { type: "wait" };

export interface ComputerSafetyCheck {
	id: string;
	code?: string | null;
	message?: string | null;
}

export interface ComputerToolCallMetadata {
	type: "computer";
	providerItemId: string;
	actions: ComputerAction[];
	pendingSafetyChecks: ComputerSafetyCheck[];
}

export type ToolCallProviderMetadata = ComputerToolCallMetadata;

export type ComputerScreenshotRef =
	| { type: "computer_screenshot"; image_url: string; file_id?: never }
	| { type: "computer_screenshot"; file_id: string; image_url?: never };

export interface ComputerToolResultMetadata {
	type: "computer";
	screenshot: ComputerScreenshotRef;
	acknowledgedSafetyChecks: ComputerSafetyCheck[];
}

export type ToolResultProviderMetadata = ComputerToolResultMetadata;

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	[kStreamingPartialJson]?: string;
	thoughtSignature?: string; // Google-specific: opaque signature for reusing thought context
	intent?: string; // Harness-level intent metadata extracted from traced tool arguments
	/**
	 * Verbatim in-band syntax block that produced this synthetic `ptc_*` call.
	 * Present only for owned prompt/tool-call formats; provider-native calls omit it.
	 */
	rawBlock?: string;
	/**
	 * Original wire-level name when the tool was invoked via OpenAI's custom-tool
	 * mechanism (e.g., `apply_patch`). Set by `openai-responses` on receive so
	 * the history-replay path can re-emit the call as `custom_tool_call` with
	 * its paired tool-result as `custom_tool_call_output`. Absent for regular
	 * JSON function tools.
	 */
	customWireName?: string;
	/** Provider-native metadata required to execute and faithfully replay this call. */
	providerMetadata?: ToolCallProviderMetadata;
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface OpenAIResponsesHistoryPayload {
	type: "openaiResponsesHistory";
	provider?: string;
	dt?: boolean;
	items: Array<Record<string, unknown>>;
}

/** Anthropic `output_config.effort` level. */
export type AnthropicOutputEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** One `tool_addition`/`tool_removal` block of an Anthropic mid-conversation system message. */
export interface AnthropicToolChange {
	type: "tool_addition" | "tool_removal";
	name: string;
}

/** Anthropic-only controls attached to a mid-conversation system message. */
export interface AnthropicMessagePayload {
	type: "anthropicMessage";
	clearAt?: "never" | "next_user_message";
	effort?: AnthropicOutputEffort;
	toolChanges?: AnthropicToolChange[];
}

/**
 * Controls an Anthropic request declared, recorded on its response so later
 * requests over the same transcript replay a byte-identical prefix.
 * Written by the Anthropic provider; read by it and by the Agent's inactive-tool lookup.
 */
export interface AnthropicRequestControls {
	/**
	 * `context.messages.length` of the request that produced this response, i.e. the
	 * response's own index. A record found at another index belongs to a history that was
	 * rewritten before it (compaction, dropped messages) and is not replayed as controls.
	 */
	messageIndex: number;
	/** Present when the request kept a stable tool declaration (`supportsMidConversationToolChanges`). Source tool names, not wire names. */
	tools?: {
		/** Top-level `tools` in wire order. */
		declared: string[];
		/** Subset of `declared` sent with `defer_loading: true`. */
		deferred: string[];
		/** Tools active at the end of the request, in `context.tools` order. */
		active: string[];
	};
	/** Present when the request kept a stable effort (`supportsPerMessageEffort`); `null` = API default. */
	effort?: { topLevel: AnthropicOutputEffort | null; tail: AnthropicOutputEffort | null };
}

/**
 * Anthropic on-demand compaction summary (`compact-2026-09-04` beta).
 *
 * Produced by the Anthropic provider on the assistant message of a request
 * that streamed a `compaction` content block, and attached to the user-role
 * compaction summary message that replaces the compacted history so the
 * provider can replay the block verbatim: the API drops every block that
 * precedes it. `content` is the plain-text summary, so every other provider
 * reads the message text and ignores the payload.
 */
export interface AnthropicCompactionPayload {
	type: "anthropicCompaction";
	/** Provider that produced the summary; only that provider replays it natively. */
	provider: string;
	content: string;
	/** Signature of an on-demand block; replayed verbatim. */
	signature?: string;
	/** Legacy threshold block state (`compact-2026-01-12`); replay-only. */
	encryptedContent?: string;
	/**
	 * Harness-appended file metadata (`<files>` section) kept out of the
	 * byte-identical block. The converter replaces the summary message with the
	 * block and skips its text, so it replays this as a user message after the
	 * block's retained tail: before the first message created after the summary.
	 */
	filesText?: string;
	/**
	 * File metadata of earlier summaries whose replay position lies inside this
	 * summary's retained tail. Retained messages must reach the API unchanged,
	 * so each keeps replaying where it did: before the first message created
	 * after `after` (the earlier summary's commit time).
	 */
	retainedFiles?: AnthropicCompactionFiles[];
	/**
	 * Set on summaries whose retained tail replays unchanged: file metadata
	 * after the tail, earlier metadata at `retainedFiles`. Summaries persisted
	 * without it keep their original layout (metadata after the first retained
	 * turn), since later thinking was signed against those bytes.
	 */
	exactTail?: true;
}

/** File metadata replayed at a fixed point of a natively compacted conversation. */
export interface AnthropicCompactionFiles {
	text: string;
	/** Replays before the first message created after this time (ms). */
	after: number;
}

export type ProviderPayload = OpenAIResponsesHistoryPayload | AnthropicMessagePayload | AnthropicCompactionPayload;

/** Provider-reported rewrite applied to request content before inference. */
export interface ProviderInputTransformation {
	type: string;
	path?: string;
	reason?: string;
	[key: string]: unknown;
}

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	/** True if the message was injected by the system (e.g., auto-continue). */
	synthetic?: boolean;
	/** True when injected mid-turn as a steer; consumed by the agent's pre-LLM transform to wrap it for emphasis. Never rendered. */
	steering?: boolean;
	/** True when the provider delivered this steer into the response it was streaming (`response.steer`). Display-only; never sent. */
	liveSteered?: boolean;
	/** Timestamp of a client-side history rewrite represented by this message. */
	historyRewriteAt?: number;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	/** Provider-specific opaque payload used to reconstruct transport-native history. */
	providerPayload?: ProviderPayload;
	timestamp: number; // Unix timestamp in milliseconds
}

export interface DeveloperMessage {
	role: "developer";
	content: string | (TextContent | ImageContent)[];
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	/** True if the message was injected by the system (e.g., auto-continue) and initiates a fresh run rather than continuing the current one. */
	synthetic?: boolean;
	/** True when the synthetic prompt was a deliberate operator action (`.`, `c` continue shortcut) rather than an automatic continuation — its timestamp is the turn's prompt time. */
	userInitiated?: boolean;
	/** Provider-specific opaque payload used to reconstruct transport-native history. */
	providerPayload?: ProviderPayload;
	timestamp: number; // Unix timestamp in milliseconds
}

/** How an automatic retry recovered or ultimately settled a failed attempt. */
export type AssistantRetryRecoveryKind = "credential" | "model" | "wait" | "plain";

/** Persisted presentation state for an assistant error superseded by an automatic retry saga. */
export type AssistantRetryRecovery =
	| {
			kind: "auto-retry";
			status: "recovered";
			attempt: number;
			recoveredAt: string;
			recovery: AssistantRetryRecoveryKind;
			note: string;
			supersededBy?: {
				timestamp: number;
				responseId?: string;
				provider: string;
				model: string;
			};
	  }
	| {
			kind: "auto-retry";
			status: "superseded";
			attempt: number;
			recovery: AssistantRetryRecoveryKind;
			note: string;
	  };

export interface ContextSnapshot {
	promptTokens: number; // authoritative provider prompt/input tokens
	nonMessageTokens: number; // estimated non-message total at send time
	/** Estimated prompt tokens removed by local history rewrites after this provider snapshot was recorded. */
	historyRewriteTokensRemoved?: number;
	/**
	 * Compaction epoch current when this snapshot's provider request was recorded.
	 * A later compaction bumps the session epoch, so an anchor whose epoch is
	 * older than the current in-flight snapshot describes pre-compaction history
	 * and must not override the rebased estimate.
	 */
	compactionEpoch?: number;
	lastMessageTimestamp?: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: (
		| TextContent
		| ThinkingContent
		| RedactedThinkingContent
		| AnthropicFallbackContent
		| AnthropicServerToolContent
		| ImageContent
		| ToolCall
	)[];
	api: Api;
	provider: Provider;
	model: string;
	/** Stored credential row that produced this turn; absent for external or unknown keys. */
	credentialId?: number;
	contextSnapshot?: ContextSnapshot;
	retryRecovery?: AssistantRetryRecovery;
	responseId?: string; // Provider-specific response/message identifier when the upstream API exposes one
	/**
	 * Name of the upstream provider an aggregator routed this request to, as
	 * reported in the response (e.g. OpenRouter's top-level `provider` field:
	 * `"OpenAI"`, `"Anthropic"`, `"Together"`). Distinct from `provider`, which
	 * is the configured gateway we called (`"openrouter"`). Undefined for direct
	 * providers that expose no such field.
	 */
	upstreamProvider?: string;
	/**
	 * Concrete model that produced this turn when it is knowable independently
	 * of the requested id: reported by a router that selected one, or recovered
	 * from a signed thinking block (Anthropic signatures name the serving
	 * model). Compared against `model` to notice a gateway serving something
	 * other than what was requested.
	 */
	upstreamModel?: string;
	/**
	 * Service tier the provider reported serving this turn, when the API echoes
	 * one (`response.service_tier`), falling back to the tier the request carried
	 * when the response omits the echo. Absent when the provider reports no tier
	 * or the echo cannot be trusted (proxies). This is the tier the turn actually
	 * ran on, which is what cost, premium-request, and speed accounting key on —
	 * the session's live setting may already have changed.
	 */
	serviceTier?: ServiceTier;
	usage: Usage;
	stopReason: StopReason;
	stopDetails?: StopDetails | null;
	errorMessage?: string;
	/** Stable recovery-classification text when errorMessage includes display-only diagnostics. */
	errorClassificationMessage?: string;
	/** True only when an exact request-body-read timeout failed on a full Responses replay, not a previous-response delta. */
	requestBodyReadTimeoutFullReplay?: boolean;
	/** Per-tool abort messages used when an aborted assistant turn needs different placeholder results per tool call. */
	toolCallAbortMessages?: Record<string, string>;
	/** HTTP status surfaced by the provider when the request failed. Populated by every provider's catch block alongside `errorMessage` so consumers (auth retry, telemetry, UI) can branch without regex-scraping the message. */
	errorStatus?: number;
	/** Structured machine-readable error classifier; see `utils/error-id.ts` for bit layout and helpers. */
	errorId?: number;
	/**
	 * Stable identifiers for request features the provider silently dropped
	 * during this turn (e.g. `"priority"`). Set when a server-side rejection
	 * triggered an in-provider fallback retry that succeeded without the
	 * feature. Callers can use this to sync user-facing toggles back to the
	 * server's actual state.
	 */
	disabledFeatures?: string[];
	/** Provider-reported input rewrites such as dropped bound-thinking blocks. */
	inputTransformations?: ProviderInputTransformation[];
	/**
	 * Controls an Anthropic request declared, recorded on its response so later
	 * requests over the same transcript replay a byte-identical prefix.
	 */
	requestControls?: AnthropicRequestControls;
	/** Provider-specific opaque payload used to reconstruct transport-native history. */
	providerPayload?: ProviderPayload;
	/** In-memory fallback credit handle attached when a refusal response carries a fallback credit token. */
	fallbackCreditHandle?: AnthropicFallbackCreditHandle;
	timestamp: number; // Unix timestamp in milliseconds
	duration?: number; // Request duration in milliseconds
	ttft?: number; // Time to first token in milliseconds
	/** Local wall-clock time the response finished streaming (ms since epoch); stamped by the session at message_end so prompt→yield timing never depends on provider-reported duration. */
	completedAt?: number;
}

export interface ToolResultMessage<TDetails = unknown> {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[]; // Supports text and images
	details?: TDetails;
	isError: boolean;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	/** Timestamp when output was pruned (ms since epoch). Undefined if unpruned. */
	prunedAt?: number;
	/** Provider-native metadata required to faithfully replay this result. */
	providerMetadata?: ToolResultProviderMetadata;
	/**
	 * Tool-declared: this result carried no information worth retaining once
	 * consumed (zero matches, elapsed wait). Compaction passes may elide it.
	 * Never set together with isError.
	 */
	useless?: boolean;
	timestamp: number; // Unix timestamp in milliseconds
}

export type Message = UserMessage | DeveloperMessage | AssistantMessage | ToolResultMessage;
export interface AnthropicFallbackCreditHandle {
	token: string;
	prefillClaim?: boolean | null;
	params: unknown;
	betas?: readonly string[];
	betaHeader?: string;
	expiresAt: number;
	/** The refused response's content, in `AssistantMessage` block form. */
	refusedContent?: AssistantMessage["content"];
}
