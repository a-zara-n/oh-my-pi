/**
 * The per-attempt hook for fetch-based model requests.
 *
 * Every call of a gated `fetch` is one wire attempt. With a gate registered it is authorized before any I/O, told to
 * start sending immediately before the first byte, shown the response as it streams past (unaltered), and settled
 * exactly once however it ends. With no gate registered the gated fetch is the underlying fetch: nothing is built,
 * read or wrapped.
 *
 * What the gate is given of the request is the core's own credential-free view ({@link ModelRequestWire}); the body
 * is only ever held in memory and only when the gate asks for it.
 *
 * @internal
 */
import { Buffer } from "node:buffer";
import { logger } from "@oh-my-pi/pi-utils";
import { ModelRequestDeniedError } from "../error/model-request-denied";
import type { FetchImpl } from "../types";
import type {
	ModelRequestKind,
	ModelRequestLease,
	ModelRequestModelRef,
	ModelRequestOutcome,
	ModelRequestWire,
} from "../model-request-gate";
import { nextModelRequestAttemptLink } from "../model-request-lineage";
import { getModelRequestRuntime } from "../model-request-runtime";
import { copyResponseMetadata } from "./request-debug";

/** Stamped on a fetch that already authorizes each of its calls, so wrapping layers never authorize twice. */
const GATED_FETCH = Symbol("omp.modelRequestGatedFetch");

/** Header and query names whose values are credentials (or may carry one) and are never shown to a gate. */
const CREDENTIAL_NAME = /auth|key|token|secret|cookie|credential|signature|password|passwd|bearer|^sig$/i;

function stripUrl(raw: string): string {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		const query = raw.indexOf("?");
		return query < 0 ? raw : raw.slice(0, query);
	}
	parsed.username = "";
	parsed.password = "";
	parsed.hash = "";
	for (const name of [...parsed.searchParams.keys()]) {
		if (CREDENTIAL_NAME.test(name)) parsed.searchParams.delete(name);
	}
	return parsed.toString();
}

function wireHeaders(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	headers.forEach((value, name) => {
		if (!CREDENTIAL_NAME.test(name)) out[name.toLowerCase()] = value;
	});
	return out;
}

/** Response headers a gate may see: everything except cookies and credential-looking names. */
function responseHeaders(headers: Headers): Record<string, string> {
	return wireHeaders(headers);
}

interface BodySource {
	readonly bytes: number;
	read(): Promise<Uint8Array>;
}

const EMPTY_BODY: BodySource = { bytes: 0, read: async () => new Uint8Array(0) };

/**
 * The request body as readable bytes with a known length, or `undefined` when it cannot be read without consuming it
 * or sending it (a stream, `FormData`, a `Request` that carries its own body). A gate treats `undefined` as an
 * unsupported transport.
 */
function bodySource(input: string | URL | Request, init: RequestInit | undefined): BodySource | undefined {
	const body = init?.body;
	if (body === undefined || body === null) {
		if (input instanceof Request && input.body !== null) return undefined;
		return EMPTY_BODY;
	}
	if (typeof body === "string") {
		return { bytes: Buffer.byteLength(body), read: async () => new TextEncoder().encode(body) };
	}
	if (body instanceof URLSearchParams) {
		const text = body.toString();
		return { bytes: Buffer.byteLength(text), read: async () => new TextEncoder().encode(text) };
	}
	if (body instanceof ArrayBuffer) {
		return { bytes: body.byteLength, read: async () => new Uint8Array(body.slice(0)) };
	}
	if (ArrayBuffer.isView(body)) {
		return {
			bytes: body.byteLength,
			read: async () => new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)),
		};
	}
	if (body instanceof Blob) {
		return { bytes: body.size, read: async () => new Uint8Array(await body.arrayBuffer()) };
	}
	return undefined;
}

function resolveMethod(input: string | URL | Request, init: RequestInit | undefined): string {
	return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

function resolveUrl(input: string | URL | Request): string {
	return input instanceof Request ? input.url : input.toString();
}

function resolveHeaders(input: string | URL | Request, init: RequestInit | undefined): Headers {
	if (init?.headers) return new Headers(init.headers);
	return input instanceof Request ? new Headers(input.headers) : new Headers();
}

/** The credential-free description of a fetch call handed to the gate, or `undefined` when its body is unreadable. */
export function buildModelRequestWire(
	input: string | URL | Request,
	init: RequestInit | undefined,
): ModelRequestWire | undefined {
	const source = bodySource(input, init);
	if (source === undefined) return undefined;
	return Object.freeze({
		method: resolveMethod(input, init),
		url: stripUrl(resolveUrl(input)),
		headers: Object.freeze(wireHeaders(resolveHeaders(input, init))),
		bodyBytes: source.bytes,
		readBody: () => source.read(),
	});
}

function modelRef(model: ModelRequestModelRef): ModelRequestModelRef {
	return {
		provider: model.provider,
		id: model.id,
		api: model.api,
		...(model.baseUrl === undefined ? {} : { baseUrl: model.baseUrl }),
	};
}

async function settleQuietly(lease: ModelRequestLease, outcome: ModelRequestOutcome): Promise<void> {
	try {
		await lease.settle(outcome);
	} catch (error) {
		// Never let a gate's bookkeeping failure replace the request's own result.
		logger.warn("model request lease settle failed", { error: error instanceof Error ? error.message : String(error) });
	}
}

function observeQuietly(operation: string, observe: () => void): void {
	try {
		observe();
	} catch (error) {
		logger.warn("model request lease observation failed", {
			operation,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Pass `response` through to the caller unchanged while telling `lease` what flows by, and settle the lease exactly
 * once: when the body ends, when it fails, when the caller cancels it, or when the request's signal aborts.
 */
function observeResponse(lease: ModelRequestLease, response: Response, signal: AbortSignal | undefined): Response {
	observeQuietly("observeResponse", () =>
		lease.observeResponse({ status: response.status, headers: responseHeaders(response.headers) }),
	);
	let settled = false;
	let onAbort: (() => void) | undefined;
	const finish = (outcome: ModelRequestOutcome): void => {
		if (settled) return;
		settled = true;
		if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
		void settleQuietly(lease, outcome);
	};
	const upstream = response.body;
	if (upstream === null) {
		finish({ type: "response-ended", status: response.status });
		return response;
	}
	onAbort = () =>
		finish({ type: "response-failed", status: response.status, aborted: true, transportClosed: true });
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });

	const reader = upstream.getReader();
	/** The read currently in flight, so a cancel that races the end of the body can wait for it. */
	let inFlight: Promise<void> | undefined;
	const pullOnce = async (controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
		try {
			const { done, value } = await reader.read();
			if (done) {
				finish({ type: "response-ended", status: response.status });
				controller.close();
				return;
			}
			observeQuietly("observeChunk", () => lease.observeChunk(Uint8Array.from(value)));
			controller.enqueue(value);
		} catch (error) {
			finish({
				type: "response-failed",
				status: response.status,
				aborted: signal?.aborted === true,
				transportClosed: true,
			});
			controller.error(error);
		}
	};
	const passthrough = new ReadableStream<Uint8Array>({
		pull(controller) {
			inFlight = pullOnce(controller);
			return inFlight;
		},
		async cancel(reason) {
			// Consumers stop reading as soon as they see the protocol's terminal event, which can be a moment before the
			// transport reports the end of the body. Let a read that is already in flight land (bounded to one macrotask)
			// so a body that was in fact fully delivered is settled as ended, not as aborted.
			if (inFlight !== undefined) {
				const grace = Promise.withResolvers<void>();
				const timer = setTimeout(grace.resolve, 0);
				await Promise.race([inFlight, grace.promise]);
				clearTimeout(timer);
			}
			finish({ type: "response-failed", status: response.status, aborted: true, transportClosed: true });
			await reader.cancel(reason);
		},
	});
	const wrapped = new Response(passthrough, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
	copyResponseMetadata(wrapped, response);
	return wrapped;
}

export interface GatedSendArgs {
	readonly model: ModelRequestModelRef;
	readonly kind: ModelRequestKind;
	readonly input: string | URL | Request;
	readonly init: RequestInit | undefined;
	/** Performs the actual I/O. Not called unless the gate permits. */
	readonly send: () => Promise<Response>;
}

/**
 * Authorize one wire attempt and, if permitted, send it under a lease. Throws `ModelRequestDeniedError` (before any
 * I/O) when the gate refuses or fails.
 */
export async function gatedSend(args: GatedSendArgs): Promise<Response> {
	const runtime = getModelRequestRuntime();
	if (!runtime.hasGate()) return args.send();
	const { input, init } = args;
	const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
	const link = nextModelRequestAttemptLink();
	const permit = await runtime.authorize({
		requestId: link.requestId,
		reason: link.reason,
		...(link.retryOf === undefined ? {} : { retryOf: link.retryOf }),
		kind: args.kind,
		model: modelRef(args.model),
		wire: buildModelRequestWire(input, init),
		...(signal === undefined || signal === null ? {} : { signal }),
	});
	link.record(permit.attemptId);
	const lease = permit.lease;
	if (lease === undefined) return args.send();
	const effectiveSignal = signal ?? undefined;
	if (effectiveSignal?.aborted) {
		await settleQuietly(lease, { type: "not-sent", aborted: true });
		throw effectiveSignal.reason ?? new Error("model request aborted before it was sent");
	}
	lease.beginSend();
	let response: Response;
	try {
		response = await args.send();
	} catch (error) {
		await settleQuietly(lease, {
			type: "request-failed",
			sent: "maybe",
			aborted: effectiveSignal?.aborted === true,
			transportClosed: true,
		});
		throw error;
	}
	return observeResponse(lease, response, effectiveSignal);
}

/**
 * `base` with every call authorized as one wire attempt of `kind`. Returns `base` itself when it already authorizes its
 * calls. With no gate registered, a call goes straight to `base`.
 */
export function gateFetch(model: ModelRequestModelRef, kind: ModelRequestKind, base: FetchImpl): FetchImpl {
	if (Reflect.has(base, GATED_FETCH)) return base;
	const gated: FetchImpl = (input, init) => gatedSend({ model, kind, input, init, send: () => base(input, init) });
	if (base.preconnect) gated.preconnect = base.preconnect;
	return markFetchGated(gated);
}

/** Mark a fetch the caller has already built around {@link gatedSend}, so {@link gateFetch} leaves it alone. */
export function markFetchGated<T extends FetchImpl>(fetch: T): T {
	Object.defineProperty(fetch, GATED_FETCH, { value: true });
	return fetch;
}

/**
 * Authorize an attempt whose transport the core cannot instrument (it does not go through a fetch the core controls:
 * WebSocket, an SDK's own client, a provider-supplied stream function). The gate is shown `wire: undefined` and must
 * answer `pass` (not its concern) or `deny`. Nothing could drive an `allow` lease (no `beginSend` point, no response
 * to observe), so an `allow` is released as not-sent and refused: a gate cannot permit what the core cannot account for.
 */
export async function authorizeUninstrumentedAttempt(
	model: ModelRequestModelRef,
	kind: ModelRequestKind,
	signal: AbortSignal | undefined,
): Promise<void> {
	const runtime = getModelRequestRuntime();
	if (!runtime.hasGate()) return;
	const link = nextModelRequestAttemptLink();
	const permit = await runtime.authorize({
		requestId: link.requestId,
		reason: link.reason,
		...(link.retryOf === undefined ? {} : { retryOf: link.retryOf }),
		kind,
		model: modelRef(model),
		wire: undefined,
		...(signal === undefined ? {} : { signal }),
	});
	link.record(permit.attemptId);
	if (permit.lease === undefined) return;
	await settleQuietly(permit.lease, { type: "not-sent", aborted: false });
	throw new ModelRequestDeniedError(
		"transport-unsupported",
		"this transport cannot be accounted for by the request gate, so the request was not sent",
	);
}
