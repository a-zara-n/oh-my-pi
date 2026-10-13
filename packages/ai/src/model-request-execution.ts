/**
 * Core-owned execution context for model requests.
 *
 * @internal Not part of the public pi-ai surface (deliberately absent from `index.ts`). The core installs a
 * context around a session, an agent-loop turn, an extension handler/tool/command, a child session or a
 * session-derived background job; request paths read it back to learn who is asking. A request path never
 * accepts `origin`, `scope` or a root from its caller, so nothing a caller passes can claim to be standalone,
 * detached, or another session's root.
 */
import type { ModelRequestPurpose, ModelRequestScope } from "./model-request-gate";
import {
	getModelRequestRuntime,
	type ModelRequestAuthorizationInput,
	type ModelRequestExecution,
	type ModelRequestExecutionInit,
	type ModelRequestExecutionPatch,
	type ModelRequestPermit,
} from "./model-request-runtime";

export {
	ModelRequestProcessClassError,
	type ModelRequestAuthorizationInput,
	type ModelRequestExecution,
	type ModelRequestExecutionInit,
	type ModelRequestExecutionPatch,
	type ModelRequestPermit,
	type ModelRequestRootSource,
} from "./model-request-runtime";

/** Mint the context of a session being created. Throws in a process marked standalone. */
export function createModelRequestSessionExecution(init: ModelRequestExecutionInit): ModelRequestExecution {
	return getModelRequestRuntime().createSessionExecution(init);
}

/** Derive a context from a core-minted one with a different purpose or agent identity (same session id and root). */
export function deriveModelRequestExecution(
	parent: ModelRequestExecution,
	patch: ModelRequestExecutionPatch,
): ModelRequestExecution {
	return getModelRequestRuntime().deriveExecution(parent, patch);
}

/** The active core-minted context, or `undefined`. A stored object the core did not mint is not a context. */
export function getModelRequestExecution(): ModelRequestExecution | undefined {
	return getModelRequestRuntime().currentExecution();
}

export function runWithModelRequestExecution<T>(execution: ModelRequestExecution, fn: () => T): T {
	return getModelRequestRuntime().runWith(execution, fn);
}

/** Run `fn` declaring a purpose for the requests it makes. A no-op when no context is active. */
export function runWithModelRequestPurpose<T>(purpose: ModelRequestPurpose, fn: () => T): T {
	return getModelRequestRuntime().withPurpose(purpose, fn);
}

/**
 * Re-bind `fn` to the context active now. For event listeners, timers and queued jobs: those run in the
 * context of whoever emits/fires them, not of whoever registered them.
 */
export function bindModelRequestExecution<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
	return getModelRequestRuntime().bind(fn);
}

/** The scope a context resolves to right now (root and session ids are re-evaluated on every call). */
export function resolveModelRequestScope(execution: ModelRequestExecution): ModelRequestScope {
	return getModelRequestRuntime().scopeOf(execution);
}

/** Mark this process a session-less command. Throws if a session context was already created. */
export function markModelRequestProcessStandalone(): void {
	getModelRequestRuntime().markStandalone();
}

/**
 * Ask the registered gate about one wire attempt. Throws `ModelRequestDeniedError` when the request must not
 * be sent; resolves to a lease-less permit when no gate is registered or the gate answered `pass`.
 */
export function authorizeModelRequest(input: ModelRequestAuthorizationInput): Promise<ModelRequestPermit> {
	return getModelRequestRuntime().authorize(input);
}
