/**
 * Static inventory of the paths that can send a model request, and how each relates to the request gate.
 *
 * Two independent facts decide whether a site is covered:
 * - {@link ModelRequestContextPropagation}: does the core execution context reach the site (so the gate learns
 *   who is asking)? Verified by tests for the sites this change wires; `unverified` where no evidence exists.
 * - {@link ModelRequestGateHook}: does a request from the site pass the gate before any I/O?
 *
 * A site is `gated` when it calls the gate itself, `context-inherited` when its requests reach a shared per-attempt
 * hook with the context intact, and `uncovered` otherwise — including every site whose context is not carried or
 * not verified. `coverage.complete` is true only when nothing is uncovered, so an unverified path can never be
 * reported as complete.
 *
 * This table is the single place new request paths must be added; the inventory version changes with any edit.
 */
import type {
	ModelRequestContextPropagation,
	ModelRequestCoverage,
	ModelRequestCoverageSite,
	ModelRequestSiteStatus,
} from "./model-request-gate";

/** Where the gate decision happens for a site's requests. */
export type ModelRequestGateHook =
	/** The site's requests do not reach any gate call yet. */
	| "missing"
	/** The requests reach the shared per-attempt transport/judge hook. */
	| "per-attempt"
	/** The site calls the gate itself. */
	| "site"
	/** The row is not a request path (context installation, process classification). */
	| "not-applicable";

interface ModelRequestSiteRow {
	readonly id: string;
	readonly location: string;
	readonly contextPropagation: ModelRequestContextPropagation;
	readonly hook: ModelRequestGateHook;
	/** What is missing or unproven; empty for a covered site. */
	readonly note: string;
}

const NO_HOOK = "no per-attempt gate hook is installed yet";

function row(
	id: string,
	location: string,
	contextPropagation: ModelRequestContextPropagation,
	hook: ModelRequestGateHook,
	note: string,
): ModelRequestSiteRow {
	return { id, location, contextPropagation, hook, note };
}

/**
 * Site ids S-01..S-37 follow the design inventory; S-38 and up were found while wiring the context. Locations are
 * paths in this repository. The design's S-24 (a catch-all for paths that cannot carry the context) has no row of its
 * own: it is replaced by the concrete boundaries S-37 (Worker host re-entry), S-38, S-39, S-40, S-41, S-43 and S-44,
 * and S-25/S-26 are the installation and standalone-mark rows. Do not re-add S-24 as a vague row; add the specific path.
 */
const SITE_ROWS: readonly ModelRequestSiteRow[] = [
	row("S-01", "packages/ai/src/utils/transport-fetch.ts", "inherited", "missing", NO_HOOK),
	row("S-02", "packages/ai/src/stream.ts: stream, streamSimple, complete, completeSimple", "inherited", "missing", NO_HOOK),
	row("S-03", "packages/ai/src/stream.ts: auth-rotation and thinking-loop re-entry", "inherited", "missing", NO_HOOK),
	row("S-04", "packages/ai/src/providers/anthropic.ts: provider-internal retry", "inherited", "missing", NO_HOOK),
	row("S-05", "packages/ai/src/stream.ts streamDispatch: custom API, pi-native, gitlab-duo, vertex, bedrock, kimi, synthetic", "inherited", "missing", `${NO_HOOK}; request body is not readable on these transports`),
	row("S-06", "packages/ai/src/providers: WebSocket and SDK transports", "inherited", "missing", `${NO_HOOK}; request body is not readable on these transports`),
	row("S-07", "packages/ai/src/judgment/typesafe.ts: native judge fetch", "inherited", "missing", NO_HOOK),
	row("S-08", "packages/ai/src/judgment/chat.ts: chat judge", "inherited", "missing", NO_HOOK),
	row("S-09", "packages/coding-agent/src/judgment/index.ts: ChainJudge", "inherited", "missing", NO_HOOK),
	row("S-10", "packages/coding-agent/src/sdk.ts: session stream functions (main, subagent)", "installed", "missing", NO_HOOK),
	row("S-11", "packages/coding-agent/src/session/cache-warmer.ts: cache warm-up replay", "installed", "missing", NO_HOOK),
	row("S-12", "packages/coding-agent/src/session: compaction, handoff, branch summary, side-channel requests", "installed", "missing", NO_HOOK),
	row("S-13", "packages/coding-agent/src/session/turn-recovery.ts: turn retry and model fallback", "inherited", "missing", NO_HOOK),
	row("S-14", "packages/coding-agent/src/commit, utils/commit-message-generator.ts: commit message generation", "unverified", "missing", `${NO_HOOK}; context is inherited only when called from a session, and \`omp commit\` is not marked standalone`),
	row("S-15", "packages/coding-agent/src/utils/title-generator.ts: title generation", "installed", "missing", NO_HOOK),
	row("S-16", "packages/coding-agent/src/edit/auto-repair.ts: auto-repair", "inherited", "missing", NO_HOOK),
	row("S-17", "packages/coding-agent/src/memories, mnemopi, sharpshooter and packages/mnemopi: memory and summarization jobs", "explicit-bind", "missing", NO_HOOK),
	row("S-18", "packages/coding-agent/src/tts/speech-enhancer.ts, extensibility/custom-commands/bundled/annotate: speech enhancement and annotation", "unverified", "missing", `${NO_HOOK}; the callers' context was not verified`),
	row("S-19", "packages/mnemopi/src/core/local-llm.ts, packages/agent/src/telemetry.ts: completion helpers", "unverified", "missing", `${NO_HOOK}; whether they reach an external request was not verified`),
	row("S-20", "packages/coding-agent/src/extensibility/legacy-pi-ai-shim.ts: extension-called streamSimple", "installed", "missing", NO_HOOK),
	row("S-21", "packages/coding-agent/src/cli/auth-gateway-cli.ts: gateway diagnostic completion", "standalone-mark", "missing", NO_HOOK),
	row("S-22", "packages/ai/src/embeddings, rerank, images, speech, transcription, video: non-chat kinds", "unverified", "missing", `${NO_HOOK}; no per-kind adapter has been checked`),
	row("S-23", "other call sites that matched a search for stream(/complete( (compress, if-bench, ida store, ...)", "unverified", "missing", "not confirmed to be external requests"),
	row("S-25", "core context installation: createAgentSession, agent loop runs, extension handlers/tools/commands/timers, child sessions, advisor, background jobs", "installed", "not-applicable", ""),
	row("S-26", "standalone command entries marked in packages/coding-agent/src/cli.ts (session-less commands)", "standalone-mark", "not-applicable", ""),
	row("S-27", "packages/coding-agent/src/extensibility/legacy-pi-ai-shim.ts: anthropicMessagesApi().stream", "inherited", "missing", `${NO_HOOK}; bypasses the stream entry and transport-fetch`),
	row("S-28", "packages/ai providers/* imported directly through the ./* export map", "inherited", "missing", `${NO_HOOK}; bypasses the stream entry and transport-fetch`),
	row("S-29", "packages/ai/src/providers/cursor.ts: HTTP/2 transport", "inherited", "missing", `${NO_HOOK}; ignores a fetch override`),
	row("S-30", "packages/ai/src/providers/bedrock*.ts: SDK transport and options.fetch fallbacks", "inherited", "missing", `${NO_HOOK}; ignores a fetch override`),
	row("S-31", "packages/ai/src/providers/pi-native-client.ts, pi-native-server.ts", "inherited", "missing", `${NO_HOOK}; falls back to the global fetch`),
	row("S-32", "packages/ai/src/judgment/typesafe.ts: TypeSafeJudge created outside ChainJudge", "unverified", "missing", `${NO_HOOK}; creation sites not fully enumerated`),
	row("S-33", "packages/ai/src/providers: apple-foundation-models, devin, factory-droid gemini", "unverified", "missing", `${NO_HOOK}; transports not verified`),
	row("S-34", "packages/ai/src/images/shared.ts", "inherited", "missing", `${NO_HOOK}; no per-kind adapter has been checked`),
	row("S-35", "SDK-based providers (openai, anthropic, google genai, bedrock): whether options.fetch reaches the SDK", "unverified", "missing", `${NO_HOOK}; not verified`),
	row("S-36", "auth and oauth fetches (auth-broker client and similar)", "unverified", "missing", "not classified as inference or non-inference"),
	row("S-37", "packages/coding-agent/src: JS eval, browser tab and computer Workers re-entering the host for agent(), completion and tools (eval/js/context-manager.ts, tools/browser/tab-supervisor.ts, tools/computer/supervisor.ts)", "explicit-bind", "missing", NO_HOOK),
	row("S-38", "packages/coding-agent/src/eval/py/tool-bridge.ts: Python eval loopback bridge", "explicit-bind", "missing", NO_HOOK),
	row("S-39", "packages/coding-agent/src/async/job-manager.ts: background jobs started from a session", "explicit-bind", "missing", NO_HOOK),
	row("S-40", "packages/ai/src/auth-gateway routes: server-side judge and forwarded requests in the gateway process", "standalone-mark", "missing", NO_HOOK),
	row("S-41", "packages/mnemopi/src/mcp-server.ts and other entry points outside a coding-agent session", "not-carried", "missing", "runs outside any coding-agent process classification; no context reaches it"),
	row("S-42", "packages/coding-agent/src/modes: rpc, acp, interactive and print entry handlers", "installed", "missing", `${NO_HOOK}; every session request goes through a session-owned stream function`),
	row("S-43", "packages/coding-agent/src/cli.ts worker selectors: tab, computer, js eval worker body, STT/TTS, mnemopi embed, stats activity/sync, terminal output, parent watchdog, broker, lsp mux, ida host, blob broker, text predict, tiny inference", "unverified", "missing", "no context crosses a Worker/process boundary; the entry modules import no model entry, but their transitive imports were not checked"),
	row("S-44", "packages/natives callbacks into JS (shell, pty, text predictor, audio, clipboard observers)", "unverified", "missing", "no context crosses a native callback; no call chain from one to a model entry was found by search, not proven"),
];

function statusOf(site: ModelRequestSiteRow): ModelRequestSiteStatus {
	if (site.contextPropagation === "not-carried" || site.contextPropagation === "unverified") return "uncovered";
	switch (site.hook) {
		case "site":
			return "gated";
		case "per-attempt":
			return "context-inherited";
		case "not-applicable":
			return "context-inherited";
		case "missing":
			return "uncovered";
	}
}

function reasonOf(site: ModelRequestSiteRow, status: ModelRequestSiteStatus): string {
	if (status !== "uncovered") return "";
	if (site.contextPropagation === "not-carried") return `context is not carried: ${site.note}`;
	if (site.contextPropagation === "unverified") return `unverified: ${site.note}`;
	return site.note;
}

function toSite(site: ModelRequestSiteRow): ModelRequestCoverageSite {
	const status = statusOf(site);
	return Object.freeze({
		id: site.id,
		location: site.location,
		status,
		contextPropagation: site.contextPropagation,
		reason: reasonOf(site, status),
	});
}

export const MODEL_REQUEST_SITES: readonly ModelRequestCoverageSite[] = Object.freeze(SITE_ROWS.map(toSite));

const versionBySites = new WeakMap<readonly ModelRequestCoverageSite[], string>();

function inventoryVersionOf(sites: readonly ModelRequestCoverageSite[]): string {
	const cached = versionBySites.get(sites);
	if (cached !== undefined) return cached;
	const hasher = new Bun.CryptoHasher("sha256");
	for (const site of sites) {
		hasher.update(`${site.id}\u0000${site.location}\u0000${site.status}\u0000${site.contextPropagation}\u0000${site.reason}\n`);
	}
	const version = hasher.digest("hex");
	versionBySites.set(sites, version);
	return version;
}

/**
 * Build the coverage report. `complete` requires the context self-check to have passed and no site to be
 * uncovered; `sites` exists so tests can exercise the rule on small tables.
 */
export function buildModelRequestCoverage(
	contextCheck: ModelRequestCoverage["contextCheck"],
	sites: readonly ModelRequestCoverageSite[] = MODEL_REQUEST_SITES,
): ModelRequestCoverage {
	return {
		sites,
		complete: contextCheck === "passed" && sites.every(site => site.status !== "uncovered"),
		contextCheck,
		inventoryVersion: inventoryVersionOf(sites),
	};
}
