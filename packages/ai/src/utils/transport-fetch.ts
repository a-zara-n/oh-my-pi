import { resolveExtraCa, withExtraCaInit } from "@oh-my-pi/pi-utils";
import { assertJournalExecutionReady } from "@oh-my-pi/pi-utils/model-request-journal-composition";
import { ModelRequestDeniedError } from "../error/model-request-denied";
import { getModelRequestRuntime } from "../model-request-runtime";
import { coworkFetch } from "../providers/cowork-fetch";
import { withInferenceUserAgent } from "../providers/inference-headers";
import type { FetchImpl, Model } from "../types";
import type { Api } from "@oh-my-pi/pi-utils/model-data";
import { getProxyForProvider, withProxyInit } from "./proxy";
import { gatedSend, markFetchGated } from "./model-request-fetch";
import { createFetchRequestDebugSession, isRequestDebugEnabled } from "./request-debug";
import { assertModelRequestBuiltinFetch, modelRequestBuiltinFetch } from "./model-request-builtin-fetch";
import { joinJournalOuterWork, openJournalOuterWork } from "../../internal/journal-outer-work";

/** Only functions created by this module qualify for an identity-preserving rewrap. */
const transportFetches = new WeakSet<FetchImpl>();

function requireBuiltinTransport(base: FetchImpl): void {
	try {
		assertModelRequestBuiltinFetch(base);
	} catch (error) {
		throw new ModelRequestDeniedError(
			"transport-unsupported",
			"required model request needs the startup builtin fetch",
			{
				cause: error,
			},
		);
	}
}

/**
 * The one fetch every inference request goes through. Per call it applies, in
 * order: the inference User-Agent default, `NODE_EXTRA_CA_CERTS`, the
 * per-provider proxy, and `PI_REQ_DEBUG` request/response recording — then
 * calls `fetchImpl` (or the model's default fetch) exactly once. Providers
 * never layer transport concerns themselves.
 *
 * That one call is the wire attempt: with a ModelRequestGate registered it is
 * authorized first (and settled afterwards), so a provider's own retry, a
 * credential rotation or a fallback each reach the gate as a separate attempt.
 * With no gate registered the call goes straight through, unchanged.
 *
 * Idempotent for this factory's own functions only. `streamSimple` re-enters
 * `stream`, and `streamSimpleRequest` re-enters itself on auth retries, so a
 * second layer would duplicate preparation/debug dumps. A copied property or
 * symbol on an arbitrary supplied function is never transport evidence.
 */
export function transportFetch(model: Model<Api>, fetchImpl: FetchImpl | undefined): FetchImpl {
	const execution = getModelRequestRuntime().currentExecution();
	assertJournalExecutionReady(execution);
	const required = execution !== undefined && execution.journalState !== "untracked";
	// Do not resolve a caller's global getter even while constructing a required wrapper.
	if (required) requireBuiltinTransport(modelRequestBuiltinFetch);
	const given = fetchImpl;
	if (given !== undefined && transportFetches.has(given)) return given;
	const base =
		given ??
		(required
			? modelRequestBuiltinFetch
			: model.provider === "anthropic" && model.api === "anthropic-messages"
				? coworkFetch
				: globalThis.fetch);
	if (required) requireBuiltinTransport(base);
	const proxyUrl = getProxyForProvider(model.provider);

	const prepare = (input: string | URL | Request, init: RequestInit | undefined): RequestInit | undefined => {
		init = withInferenceUserAgent(input, init);
		const extraCa = resolveExtraCa();
		if (extraCa) init = withExtraCaInit(init, extraCa);
		if (proxyUrl) init = withProxyInit(input, init, proxyUrl);
		return init;
	};
	const send = async (input: string | URL | Request, init: RequestInit | undefined): Promise<Response> => {
		if (!isRequestDebugEnabled()) return base(input, init);
		const session = await createFetchRequestDebugSession(input, init);
		return session.wrapResponse(await base(input, init));
	};
	/** The same transport with no gate: what a provider's non-inference requests (token exchange, metadata) use. */
	const ungated: FetchImpl = (input, init) => send(input, prepare(input, init));
	if (base.preconnect) ungated.preconnect = base.preconnect;
	const fetch: FetchImpl = async (input, init) => {
		const sentInit = prepare(input, init);
		const execution = getModelRequestRuntime().currentExecution();
		assertJournalExecutionReady(execution);
		if (execution !== undefined && execution.journalState !== "untracked") {
			requireBuiltinTransport(base);
			// All debug/body snapshot awaits finish before entering the journal admission path.
			// The required sender never hides an async preparation step inside its I/O callback.
			const debugWork = openJournalOuterWork(execution);
			let session: Awaited<ReturnType<typeof createFetchRequestDebugSession>> | undefined;
			try {
				session = isRequestDebugEnabled()
					? await joinJournalOuterWork(debugWork, createFetchRequestDebugSession(input, sentInit))
					: undefined;
			} finally {
				await debugWork?.end();
			}
			const response = await gatedSend({
				model,
				kind: "chat",
				input,
				init: sentInit,
				transport: base,
				send: () => base(input, sentInit),
			});
			return session === undefined ? response : session.wrapResponse(response);
		}
		return gatedSend({
			model,
			kind: "chat",
			input,
			init: sentInit,
			transport: base,
			send: () => send(input, sentInit),
		});
	};
	if (base.preconnect) fetch.preconnect = base.preconnect;
	transportFetches.add(fetch);
	return markFetchGated(fetch, ungated);
}

/** Options-bag form of {@link transportFetch}; returns `options` untouched when its fetch is already built. */
export function withTransportFetch<T extends { fetch?: FetchImpl }>(model: Model<Api>, options: T): T {
	const fetch = transportFetch(model, options.fetch);
	return fetch === options.fetch ? options : { ...options, fetch };
}
