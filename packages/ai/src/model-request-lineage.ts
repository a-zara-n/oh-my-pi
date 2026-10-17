/**
 * Which logical request, and which kind of re-attempt, a wire attempt belongs to.
 *
 * One logical request (one `stream` / `complete` / judgment call) can send several wire attempts: a provider's own
 * retry, a credential rotation, a thinking-loop re-sample, a oneshot retry, a turn retry, a model fallback, a judge
 * candidate. Each wire attempt is authorized separately, and the gate is told which one it is through the
 * attempt's `requestId`, `reason` and `retryOf`.
 *
 * A *lineage* (async context) names the logical request. A *retry chain* links consecutive attempts, possibly across
 * logical requests (a turn retry calls `streamSimple` again). The chain remembers the previous attempt's id and the
 * reason the next one is being made. Callers that re-attempt mark the reason; the transport hook reads it when it
 * builds the attempt. Nothing here can influence the trusted origin/scope of an attempt: those come from the
 * execution context, never from a lineage or a chain.
 *
 * @internal Not part of the public pi-ai surface (absent from `index.ts`).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { ModelRequestReason } from "./model-request-gate";
import type { ModelRequestModelRef } from "@oh-my-pi/pi-utils/model-request-data";

declare const RETRY_CHAIN_BRAND: unique symbol;

/** Opaque handle linking consecutive attempts of one operation. Obtain one from {@link createModelRequestRetryChain}. */
export interface ModelRequestRetryChain {
	readonly [RETRY_CHAIN_BRAND]: true;
}

class RetryChainImpl implements ModelRequestRetryChain {
	declare readonly [RETRY_CHAIN_BRAND]: true;
	lastAttemptId: string | undefined;
	/** Logical request the last attempt belonged to. */
	lastRequestId: string | undefined;
	nextReason: ModelRequestReason | undefined;
}

interface Lineage {
	readonly requestId: string;
	readonly chain: RetryChainImpl;
}

const lineageStore = new AsyncLocalStorage<Lineage>();
const destinationStore = new AsyncLocalStorage<ModelRequestModelRef>();
const chainStore = new AsyncLocalStorage<RetryChainImpl>();

function requireChain(chain: ModelRequestRetryChain): RetryChainImpl {
	if (!(chain instanceof RetryChainImpl)) throw new TypeError("not a model request retry chain");
	return chain;
}

/** A fresh chain for one operation that may re-attempt (a retry loop, a fallback walk, a judge's candidate list). */
export function createModelRequestRetryChain(): ModelRequestRetryChain {
	return new RetryChainImpl();
}

/**
 * Run `fn` as one logical request. Entered at every public request entry (`stream`, `streamSimple`, `complete`,
 * `completeSimple`, a judgment call). Re-entry from inside a logical request (`streamSimple` -> `stream`, a retry
 * loop calling its own entry again) shares the outer logical request instead of starting another.
 */
export function runWithModelRequestLineage<T>(fn: () => T): T {
	if (lineageStore.getStore() !== undefined) return fn();
	const lineage: Lineage = { requestId: crypto.randomUUID(), chain: chainStore.getStore() ?? new RetryChainImpl() };
	return lineageStore.run(lineage, fn);
}

/**
 * Run `fn` as a model request of its own, even from inside another logical request: its own `requestId` and its own
 * retry chain, so it is a `first` attempt that neither consumes the reason the enclosing request declared for its next
 * attempt nor makes that request's next attempt look like a retry of it. For a provider that makes a second, distinct
 * model request before the one the caller asked for (a router assignment that scores the prompt).
 */
export function runAsIndependentModelRequest<T>(fn: () => T): T {
	return lineageStore.run({ requestId: crypto.randomUUID(), chain: new RetryChainImpl() }, fn);
}

/**
 * Declare that the next wire attempt of the current logical request is a re-attempt of kind `reason`. A no-op outside
 * a logical request and outside a retry chain, so call sites need no guard.
 */
export function markNextModelRequestAttempt(reason: ModelRequestReason): void {
	const chain = lineageStore.getStore()?.chain ?? chainStore.getStore();
	if (chain !== undefined) chain.nextReason = reason;
}

/**
 * Run `fn` as one attempt of `chain`, optionally declaring why it is being made (`undefined` for the first one).
 * Inside an active logical request or an enclosing chain it joins that one (declaring the reason on it) instead.
 */
export function runInModelRequestRetryChain<T>(
	chain: ModelRequestRetryChain,
	reason: ModelRequestReason | undefined,
	fn: () => T,
): T {
	// Inside an active logical request, or inside an enclosing chain, join that one instead of starting another: a
	// retry loop nested in a fallback walk is one sequence of attempts, and the walk's pending reason (the first
	// inner attempt is a fallback) must survive until the first inner attempt consumes it.
	const ambient = lineageStore.getStore()?.chain ?? chainStore.getStore();
	if (ambient !== undefined) {
		if (reason !== undefined) ambient.nextReason = reason;
		return fn();
	}
	const impl = requireChain(chain);
	if (reason !== undefined) impl.nextReason = reason;
	return chainStore.run(impl, fn);
}

/** What the transport hook needs to describe the wire attempt it is about to authorize. */
export interface ModelRequestAttemptLink {
	readonly requestId: string;
	readonly reason: ModelRequestReason;
	readonly retryOf: string | undefined;
	/** Record the id the core generated for this attempt, so the next attempt can name it as `retryOf`. */
	record(attemptId: string): void;
}

/**
 * The link for the next wire attempt. Outside any logical request (a transport used directly) the attempt is its own
 * one-attempt request.
 */
export function nextModelRequestAttemptLink(): ModelRequestAttemptLink {
	const lineage = lineageStore.getStore();
	const chain = lineage?.chain ?? chainStore.getStore() ?? new RetryChainImpl();
	const requestId = lineage?.requestId ?? crypto.randomUUID();
	// A re-attempt is only what a caller declared, or a second wire attempt inside the very same logical request (a
	// provider re-sending). A new request that follows a finished one in the same chain (a summary, then a short
	// summary) is a first attempt, not a retry of it.
	let reason: ModelRequestReason = "first";
	let retryOf: string | undefined;
	if (chain.nextReason !== undefined) {
		reason = chain.nextReason;
		retryOf = chain.lastAttemptId;
	} else if (chain.lastAttemptId !== undefined && chain.lastRequestId === requestId) {
		reason = "provider-retry";
		retryOf = chain.lastAttemptId;
	}
	return {
		requestId,
		reason,
		retryOf,
		record(attemptId) {
			chain.lastAttemptId = attemptId;
			chain.lastRequestId = requestId;
			chain.nextReason = undefined;
		},
	};
}

/**
 * Run `fn` for a request addressed to `model`: what the attempt names as its model, rather than the model the
 * transport was first built for. A provider definition may rewrite a model's api and base URL after the transport
 * is bound (a gateway route), and the gate must see where the request actually goes.
 */
export function runWithModelRequestDestination<T>(model: ModelRequestModelRef, fn: () => T): T {
	return destinationStore.run(model, fn);
}

/** The model the current request is addressed to, if a provider declared one. */
export function currentModelRequestDestination(): ModelRequestModelRef | undefined {
	return destinationStore.getStore();
}
