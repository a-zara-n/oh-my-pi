/**
 * The per-attempt hook for fetch-based model requests.
 *
 * Every call of a gated `fetch` is one wire attempt. It is authorized before dispatch when a gate is registered or
 * the active execution requires a managed journal connection. Required sends consume a one-use journal admission
 * and directly invoke the startup builtin in the same stack, releasing the short root before awaiting its Promise.
 * Ordinary untracked calls retain their existing fetch and lease protocol.
 *
 * What the gate is given of the request is the core's own credential-free view ({@link ModelRequestWire}); the body
 * is only ever held in memory and only when the gate asks for it.
 *
 * @internal
 */
import { Buffer } from "node:buffer";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRequestModelRef, ModelRequestOutcome } from "@oh-my-pi/pi-utils/model-request-data";
import {
	assertJournalExecutionIdentity,
	assertJournalExecutionReady,
	beginJournalSend,
	endJournalSendStart,
	type ModelRequestExecution,
	type OpaqueSendAdmission,
	prepareJournalSend,
} from "@oh-my-pi/pi-utils/model-request-journal-composition";
import { ModelRequestDeniedError } from "../error/model-request-denied";
import type { FetchImpl } from "../types";
import type {
	ModelRequestKind,
	ModelRequestLease,
	ModelRequestWire,
} from "../model-request-gate";
import { currentModelRequestDestination, nextModelRequestAttemptLink } from "../model-request-lineage";
import {
	getModelRequestRuntime,
	type ModelRequestAuthorizationInput,
	type ModelRequestPermit,
	type ModelRequestRuntime,
} from "../model-request-runtime";
import { copyResponseMetadata } from "./request-debug";
import { assertModelRequestBuiltinFetch, modelRequestBuiltinFetch } from "./model-request-builtin-fetch";

/**
 * Every fetch that authorizes each of its calls, mapped to the same transport without the gate. Membership is how
 * wrapping layers avoid authorizing twice; the twin is for requests that are not model requests.
 */
const ungatedTwins = new WeakMap<object, FetchImpl>();

const canonicalRuntime = getModelRequestRuntime();
const canonicalAuthorize = canonicalRuntime.authorize;
const canonicalCurrentExecution = canonicalRuntime.currentExecution;
const authorizeCanonical = canonicalAuthorize.bind(canonicalRuntime);
const currentCanonicalExecution = canonicalCurrentExecution.bind(canonicalRuntime);
type RequiredPermitState = "authorized" | "prepared" | "begun" | "ended";
interface RequiredPermitRecord {
	readonly runtime: ModelRequestRuntime;
	readonly execution: ModelRequestExecution;
	readonly attemptId: string;
	readonly lease: ModelRequestLease | undefined;
	state: RequiredPermitState;
	admission?: OpaqueSendAdmission;
}
// Only this module's direct authorize return path can register a permit. Entries are never deleted or revived.
const requiredPermits = new WeakMap<ModelRequestPermit, RequiredPermitRecord>();

function currentDispatchExecution(runtime: ModelRequestRuntime): ModelRequestExecution | undefined {
	const execution = currentCanonicalExecution();
	// A mutable facade cannot hide an active required context. Preserve other
	// runtime instances' ordinary untracked behavior without trusting their calls
	// for the canonical managed path.
	if (runtime === canonicalRuntime || (execution !== undefined && execution.journalState !== "untracked")) return execution;
	return runtime.currentExecution();
}

function authorizeDispatch(runtime: ModelRequestRuntime, input: ModelRequestAuthorizationInput): Promise<ModelRequestPermit> {
	// Never reacquire the canonical method after checking its reference. This
	// also covers an ordinary execution that becomes required across an await.
	return runtime === canonicalRuntime ? authorizeCanonical(input) : runtime.authorize(input);
}

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

/** A model's base URL as the gate sees it: unchanged unless it carries a credential, so equality with the model still holds. */
function redactBaseUrl(raw: string): string {
	const stripped = stripUrl(raw);
	try {
		return stripped === new URL(raw).toString() ? raw : stripped;
	} catch {
		return stripped;
	}
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
		...(model.baseUrl === undefined ? {} : { baseUrl: redactBaseUrl(model.baseUrl) }),
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

function registerRequiredPermit(
	runtime: ModelRequestRuntime,
	execution: ModelRequestExecution,
	permit: ModelRequestPermit,
): RequiredPermitRecord {
	if (requiredPermits.has(permit)) throw new ModelRequestDeniedError("gate-error", "model request permit was already used");
	Object.freeze(permit);
	const record: RequiredPermitRecord = {
		runtime,
		execution,
		attemptId: permit.attemptId,
		lease: permit.lease,
		state: "authorized",
	};
	requiredPermits.set(permit, record);
	return record;
}

function assertRequiredPermit(
	permit: ModelRequestPermit,
	record: RequiredPermitRecord,
	state: "authorized" | "prepared",
	transport: FetchImpl | undefined,
	signal: AbortSignal | undefined,
): void {
	if (
		requiredPermits.get(permit) !== record ||
		record.state !== state ||
		record.runtime !== canonicalRuntime ||
		record.runtime.authorize !== canonicalAuthorize ||
		record.runtime.currentExecution !== canonicalCurrentExecution ||
		getModelRequestRuntime() !== record.runtime ||
		currentCanonicalExecution() !== record.execution ||
		permit.attemptId !== record.attemptId ||
		permit.lease !== record.lease
	) {
		throw new ModelRequestDeniedError("gate-error", "model request permit identity or state changed");
	}
	assertJournalExecutionIdentity(record.execution);
	assertJournalExecutionReady(record.execution);
	assertModelRequestBuiltinFetch(transport);
	if (signal?.aborted) throw signal.reason ?? new Error("model request aborted before dispatch");
}

/** Only the direct authorize return below reaches this non-exported managed dispatch path. */
async function sendRequired(
	args: GatedSendArgs,
	runtime: ModelRequestRuntime,
	execution: ModelRequestExecution,
	permit: ModelRequestPermit,
	signal: AbortSignal | undefined,
): Promise<Response> {
	const { input, init, transport } = args;
	const lease = permit.lease;
	let record: RequiredPermitRecord | undefined;
	let responsePromise: Promise<Response> | undefined;
	let responseAwaited = false;
	let dispatched = false;
	try {
		record = registerRequiredPermit(runtime, execution, permit);
		assertRequiredPermit(permit, record, "authorized", transport, signal);
		const admission = await prepareJournalSend(execution, permit);
		record.admission = admission;
		record.state = "prepared";
		let startFailure: { readonly error: unknown } | undefined;
		try {
			assertRequiredPermit(permit, record, "prepared", transport, signal);
			// A gate callback can revoke/abort/reenter. Run it BEFORE the final synchronous admission check.
			lease?.beginSend();
			assertRequiredPermit(permit, record, "prepared", transport, signal);
			if (record.admission !== admission) throw new ModelRequestDeniedError("gate-error", "model request admission changed");
			beginJournalSend(admission, execution, permit);
			record.state = "begun";
			dispatched = true;
			// No caller callback, await, or global fetch lookup between final begin and the actual builtin call.
			responsePromise = modelRequestBuiltinFetch(input, init);
		} catch (error) {
			startFailure = { error };
			throw error;
		} finally {
			record.state = "ended";
			// Real synchronous root release, including begin/lease/builtin throws and an unconsumed admission.
			try {
				endJournalSendStart(admission);
			} catch (releaseError) {
				if (startFailure !== undefined) {
					throw new AggregateError([startFailure.error, releaseError], "model request start and root release failed");
				}
				throw releaseError;
			}
		}
		responseAwaited = true;
		const response = await responsePromise;
		return lease === undefined ? response : observeResponse(lease, response, signal);
	} catch (error) {
		if (record !== undefined) record.state = "ended";
		let failure = error;
		// If synchronous release failed after dispatch, still consume the already-started Promise.
		// Preserve both failures rather than leaving a detached rejection or claiming not-sent.
		if (responsePromise !== undefined && !responseAwaited) {
			try {
				await responsePromise;
			} catch (transportError) {
				if (transportError !== failure) failure = new AggregateError([failure, transportError], "model request dispatch and release failed");
			}
		}
		if (lease !== undefined) {
			await settleQuietly(
				lease,
				dispatched
					? { type: "request-failed", sent: "maybe", aborted: signal?.aborted === true, transportClosed: responseAwaited }
					: { type: "not-sent", aborted: signal?.aborted === true },
			);
		}
		if (!dispatched && !signal?.aborted && !(failure instanceof ModelRequestDeniedError)) {
			throw new ModelRequestDeniedError("gate-error", "model request journal admission failed before dispatch", { cause: failure });
		}
		throw failure;
	}
}

export interface GatedSendArgs {
	readonly model: ModelRequestModelRef;
	readonly kind: ModelRequestKind;
	readonly input: string | URL | Request;
	readonly init: RequestInit | undefined;
	/** Exact underlying fetch reference; a callback, signature or name cannot authenticate a managed transport. */
	readonly transport?: FetchImpl;
	/** Ordinary untracked I/O only. Never evidence that a required transport is supported. */
	readonly send: () => Promise<Response>;
}

/**
 * Authorize one wire attempt and, if permitted, send it under a lease. Throws `ModelRequestDeniedError` (before any
 * I/O) when the gate refuses or fails.
 */
export async function gatedSend(args: GatedSendArgs): Promise<Response> {
	const runtime = getModelRequestRuntime();
	const execution = currentDispatchExecution(runtime);
	assertJournalExecutionReady(execution);
	if (execution !== undefined && execution.journalState !== "untracked") {
		if (
			runtime !== canonicalRuntime ||
			runtime.authorize !== canonicalAuthorize ||
			runtime.currentExecution !== canonicalCurrentExecution
		) {
			throw new ModelRequestDeniedError("gate-error", "required model request runtime identity changed");
		}
		try {
			assertModelRequestBuiltinFetch(args.transport);
		} catch (error) {
			throw new ModelRequestDeniedError("transport-unsupported", "required model request needs the startup builtin fetch", {
				cause: error,
			});
		}
	}
	if (!runtime.hasGate() && (execution === undefined || execution.journalState === "untracked")) return args.send();
	const { input, init } = args;
	const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
	const link = nextModelRequestAttemptLink();
	const permit = await authorizeDispatch(runtime, {
		requestId: link.requestId,
		reason: link.reason,
		...(link.retryOf === undefined ? {} : { retryOf: link.retryOf }),
		kind: args.kind,
		model: modelRef(currentModelRequestDestination() ?? args.model),
		wire: buildModelRequestWire(input, init),
		...(signal === undefined || signal === null ? {} : { signal }),
	});
	link.record(permit.attemptId);
	const lease = permit.lease;
	try {
		// Authorization can yield across a newly required or faulted execution family.
		assertJournalExecutionReady(execution);
	} catch (error) {
		if (lease !== undefined) await settleQuietly(lease, { type: "not-sent", aborted: signal?.aborted === true });
		throw error;
	}
	if (execution !== undefined && execution.journalState !== "untracked") {
		return sendRequired(args, runtime, execution, permit, signal ?? undefined);
	}
	if (lease === undefined) return args.send();
	const effectiveSignal = signal ?? undefined;
	if (effectiveSignal?.aborted) {
		await settleQuietly(lease, { type: "not-sent", aborted: true });
		throw effectiveSignal.reason ?? new Error("model request aborted before it was sent");
	}
	try {
		lease.beginSend();
	} catch (error) {
		// Nothing was sent. A gate whose bookkeeping fails must not leak the lease, and the failure is the gate's:
		// terminal, not a transport error a retry layer would replay.
		await settleQuietly(lease, { type: "not-sent", aborted: false });
		throw new ModelRequestDeniedError("gate-error", "model request gate failed while starting to send", { cause: error });
	}
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
 * calls. With no gate registered, an ordinary sinkless call goes straight to `base`.
 */
export function gateFetch(model: ModelRequestModelRef, kind: ModelRequestKind, base: FetchImpl): FetchImpl {
	if (ungatedTwins.has(base)) return base;
	const gated: FetchImpl = (input, init) =>
		gatedSend({ model, kind, input, init, transport: base, send: () => base(input, init) });
	if (base.preconnect) gated.preconnect = base.preconnect;
	return markFetchGated(gated, base);
}

/**
 * Mark a fetch the caller has already built around {@link gatedSend}, so {@link gateFetch} leaves it alone, and record
 * `ungated`: the same transport without the gate, which {@link auxiliaryFetch} hands to requests that are not model
 * requests.
 */
export function markFetchGated<T extends FetchImpl>(fetch: T, ungated: FetchImpl): T {
	ungatedTwins.set(fetch, ungated);
	return fetch;
}

/**
 * The fetch for a request that is NOT a model request: an OAuth/token exchange, a credential or metadata lookup, a
 * version probe, a model catalog fetch. A provider receives one gated `options.fetch` for its inference request; these
 * auxiliary requests must not use it, or the gate would be shown credential bodies and responses and would count them
 * as attempts (and a later real attempt would look like a retry of them). Returns the same transport without the gate;
 * a fetch that is not gated is returned as is.
 */
export function auxiliaryFetch(fetch: FetchImpl): FetchImpl {
	return ungatedTwins.get(fetch) ?? fetch;
}

/**
 * Authorize an ordinary untracked attempt whose transport the core cannot instrument. Required executions refuse
 * it outright: a WebSocket, an SDK's own client or a provider-supplied stream has no fixed builtin dispatch boundary.
 * For an untracked attempt the gate is shown `wire: undefined` and must
 * answer `pass` (not its concern) or `deny`. Nothing could drive an `allow` lease (no `beginSend` point, no response
 * to observe), so an `allow` is released as not-sent and refused: a gate cannot permit what the core cannot account for.
 */
export async function authorizeUninstrumentedAttempt(
	model: ModelRequestModelRef,
	kind: ModelRequestKind,
	signal: AbortSignal | undefined,
): Promise<void> {
	const runtime = getModelRequestRuntime();
	const execution = currentDispatchExecution(runtime);
	assertJournalExecutionReady(execution);
	if (execution !== undefined && execution.journalState !== "untracked") {
		throw new ModelRequestDeniedError("transport-unsupported", "required model request transport has no fixed builtin dispatch");
	}
	if (!runtime.hasGate() && (execution === undefined || execution.journalState === "untracked")) return;
	const link = nextModelRequestAttemptLink();
	const permit = await authorizeDispatch(runtime, {
		requestId: link.requestId,
		reason: link.reason,
		...(link.retryOf === undefined ? {} : { retryOf: link.retryOf }),
		kind,
		model: modelRef(model),
		wire: undefined,
		...(signal === undefined ? {} : { signal }),
	});
	try {
		assertJournalExecutionReady(execution);
		if (execution !== undefined && execution.journalState !== "untracked") {
			throw new ModelRequestDeniedError("transport-unsupported", "required model request transport has no fixed builtin dispatch");
		}
	} catch (error) {
		if (permit.lease !== undefined) {
			await settleQuietly(permit.lease, { type: "not-sent", aborted: signal?.aborted === true });
		}
		throw error;
	}
	link.record(permit.attemptId);
	if (permit.lease === undefined) return;
	await settleQuietly(permit.lease, { type: "not-sent", aborted: false });
	throw new ModelRequestDeniedError(
		"transport-unsupported",
		"this transport cannot be accounted for by the request gate, so the request was not sent",
	);
}
