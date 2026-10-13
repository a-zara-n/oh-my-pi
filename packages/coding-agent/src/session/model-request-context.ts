/**
 * Coding-agent side of the core model-request execution context.
 *
 * The pi-ai runtime owns the context (see `@oh-my-pi/pi-ai/model-request-execution`); this module only builds the
 * identity a session hands it and offers the small helpers the session boundaries share. Nothing here carries a
 * policy concept: it states who is asking (session, root, agent) and why (purpose).
 *
 * @internal
 */
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import {
	createModelRequestSessionExecution,
	deriveModelRequestExecution,
	getModelRequestExecution,
	type ModelRequestExecution,
	type ModelRequestRootSource,
	resolveModelRequestScope,
	runWithModelRequestExecution,
} from "@oh-my-pi/pi-ai/model-request-execution";
import type { ModelRequestAgent, ModelRequestPurpose } from "@oh-my-pi/pi-ai/model-request-gate";

/**
 * Hand-over of the root session id from a spawning session to a child session, passed as
 * `CreateAgentSessionOptions.modelRequestRoot`. Obtain it from the spawning session
 * (`AgentSession.childModelRequestRoot()`); never build one from a `parentSession` header or an agent id chain.
 *
 * `rootSessionId: undefined` records a child whose spawner had no root to give. It is representable on purpose: a
 * gate must see that gap (and refuse), not have it silently turned into a fresh, unmetered root.
 */
export interface ModelRequestRootAssignment {
	readonly kind: "child";
	readonly rootSessionId: string | undefined;
}

/**
 * Decide where a session being created gets its root from.
 *
 * - An explicit assignment makes it a child of that root.
 * - No assignment while another session's context is active means a session is creating a session without handing a
 *   root over: the child has no root (`rootSessionId: undefined`), never its own.
 * - No assignment and no active context means the user started it: it is its own root.
 */
export function resolveModelRequestRootSource(assignment: ModelRequestRootAssignment | undefined): ModelRequestRootSource {
	if (assignment !== undefined) return { kind: "inherited", rootSessionId: assignment.rootSessionId };
	if (getModelRequestExecution() !== undefined) return { kind: "inherited", rootSessionId: undefined };
	return { kind: "self" };
}

export interface SessionModelRequestExecutionInit {
	/** Re-evaluated on every request, so `/new` and session switches never bill a stale id. */
	readonly getSessionId: () => string;
	readonly agent: ModelRequestAgent;
	readonly modelRequestRoot: ModelRequestRootAssignment | undefined;
}

/** Mint the context of a session being created. */
export function createSessionModelRequestExecution(init: SessionModelRequestExecutionInit): ModelRequestExecution {
	return createModelRequestSessionExecution({
		sessionId: init.getSessionId,
		root: resolveModelRequestRootSource(init.modelRequestRoot),
		agent: init.agent,
		purpose: init.agent.kind === "main" ? "main" : "subagent",
	});
}

/** The root assignment a session gives to a child it spawns, resolved as of now. */
export function childModelRequestRootOf(execution: ModelRequestExecution): ModelRequestRootAssignment {
	return { kind: "child", rootSessionId: resolveModelRequestScope(execution).rootSessionId };
}

/**
 * Decorate a stream function so every request it makes runs under `execution` with `purpose`.
 * Evaluated per call, so a retry or fallback that calls the decorated function again stays inside the context.
 */
export function withModelRequestExecution(
	streamFn: StreamFn,
	execution: ModelRequestExecution,
	purpose?: ModelRequestPurpose,
): StreamFn {
	const scoped = purpose === undefined ? execution : deriveModelRequestExecution(execution, { purpose });
	return (model, context, options) => runWithModelRequestExecution(scoped, () => streamFn(model, context, options));
}
