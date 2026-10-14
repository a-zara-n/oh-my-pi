import { resolveExtraCa, withExtraCaInit } from "@oh-my-pi/pi-utils";
import { coworkFetch } from "../providers/cowork-fetch";
import { withInferenceUserAgent } from "../providers/inference-headers";
import type { Api, FetchImpl, Model } from "../types";
import { getProxyForProvider, withProxyInit } from "./proxy";
import { gatedSend, markFetchGated } from "./model-request-fetch";
import { createFetchRequestDebugSession, isRequestDebugEnabled } from "./request-debug";

/** Stamped on a fetch already built by {@link transportFetch}. */
const TRANSPORT_FETCH = Symbol("omp.transportFetch");

type TransportFetch = FetchImpl & { [TRANSPORT_FETCH]?: true };

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
 * Idempotent: the built fetch is stamped and returned as-is on later passes.
 * `streamSimple` re-enters `stream`, and `streamSimpleRequest` re-enters itself
 * on auth retries, so without the stamp each entry point would add another
 * layer (three PI_REQ_DEBUG dumps for one request).
 */
export function transportFetch(model: Model<Api>, fetchImpl: FetchImpl | undefined): FetchImpl {
	const given = fetchImpl as TransportFetch | undefined;
	if (given?.[TRANSPORT_FETCH]) return given;
	const base =
		given ?? (model.provider === "anthropic" && model.api === "anthropic-messages" ? coworkFetch : globalThis.fetch);
	const proxyUrl = getProxyForProvider(model.provider);

	const fetch: TransportFetch = async (input, init) => {
		init = withInferenceUserAgent(input, init);
		const extraCa = resolveExtraCa();
		if (extraCa) init = withExtraCaInit(init, extraCa);
		if (proxyUrl) init = withProxyInit(input, init, proxyUrl);
		const sentInit = init;
		const send = async (): Promise<Response> => {
			if (!isRequestDebugEnabled()) return base(input, sentInit);
			const session = await createFetchRequestDebugSession(input, sentInit);
			return session.wrapResponse(await base(input, sentInit));
		};
		return gatedSend({ model, kind: "chat", input, init: sentInit, send });
	};
	if (base.preconnect) fetch.preconnect = base.preconnect;
	fetch[TRANSPORT_FETCH] = true;
	return markFetchGated(fetch);
}

/** Options-bag form of {@link transportFetch}; returns `options` untouched when its fetch is already built. */
export function withTransportFetch<T extends { fetch?: FetchImpl }>(model: Model<Api>, options: T): T {
	const fetch = transportFetch(model, options.fetch);
	return fetch === options.fetch ? options : { ...options, fetch };
}
