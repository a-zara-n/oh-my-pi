/**
 * Coding-agent side of the core model-request execution context.
 *
 * The pi-ai runtime owns the ambient context; the canonical journal leaf owns managed identity and readiness.
 * This module builds the session context and offers the small helpers the session boundaries share.
 * It states who is asking (session, root, agent) and why (purpose), never a caller-issued readiness proof.
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
import type { ModelRequestAgent, ModelRequestPurpose } from "@oh-my-pi/pi-utils/model-request-data";
import type { ModelRequestJournalLeaseBinding } from "@oh-my-pi/pi-utils/model-request-journal-authority";
import {
	assertJournalExecutionIdentity,
	assertJournalExecutionReady,
} from "@oh-my-pi/pi-utils/model-request-journal-composition";

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
	readonly modelRequestJournalLeaseBinding?: ModelRequestJournalLeaseBinding;
	readonly parentExecution?: ModelRequestExecution;
}

/**
 * Decide where a session being created gets its root from.
 *
 * - An explicit assignment makes it a child of that root.
 * - No assignment while another session's context is active means a session is creating a session without handing a
 *   root over: the child has no root (`rootSessionId: undefined`), never its own.
 * - No assignment and no active context means the user started it: it is its own root.
 */
export function resolveModelRequestRootSource(
	assignment: ModelRequestRootAssignment | undefined,
	binding?: ModelRequestJournalLeaseBinding,
): ModelRequestRootSource {
	if (
		binding !== undefined &&
		assignment?.modelRequestJournalLeaseBinding !== undefined &&
		binding !== assignment.modelRequestJournalLeaseBinding
	) {
		throw new Error("model request journal binding differs from the inherited root binding");
	}
	const modelRequestJournalLeaseBinding = binding ?? assignment?.modelRequestJournalLeaseBinding;
	const activeExecution = getModelRequestExecution();
	const parentExecution = assignment?.parentExecution;
	if (parentExecution !== undefined) assertJournalExecutionIdentity(parentExecution);
	const required = modelRequestJournalLeaseBinding !== undefined ||
		parentExecution !== undefined && parentExecution.journalState !== "untracked" ||
		activeExecution !== undefined && activeExecution.journalState !== "untracked";
	if (required) {
		if (activeExecution !== undefined) {
			assertJournalExecutionReady(activeExecution);
			if (modelRequestJournalLeaseBinding !== activeExecution.modelRequestJournalLeaseBinding) {
				throw new Error("a managed child must explicitly retain its parent's model request journal binding");
			}
		}
		if (assignment !== undefined || activeExecution !== undefined) {
			if (assignment === undefined || parentExecution === undefined) {
				throw new Error("a managed child must retain its genuine parent execution");
			}
			assertJournalExecutionReady(parentExecution);
			if (parentExecution.journalState === "untracked" ||
				modelRequestJournalLeaseBinding !== parentExecution.modelRequestJournalLeaseBinding ||
				assignment.rootSessionId !== resolveModelRequestScope(parentExecution).rootSessionId ||
				assignment.rootSessionId !== modelRequestJournalLeaseBinding?.rootSessionId) {
				throw new Error("model request journal root differs from its genuine parent");
			}
			if (activeExecution !== undefined &&
				resolveModelRequestScope(activeExecution).rootSessionId !== assignment.rootSessionId) {
				throw new Error("model request journal root differs from the active parent");
			}
		}
	}
	if (assignment !== undefined) {
		return Object.freeze({
			kind: "inherited", rootSessionId: assignment.rootSessionId,
			modelRequestJournalLeaseBinding, parentExecution,
		});
	}
	if (activeExecution !== undefined) {
		return { kind: "inherited", rootSessionId: undefined, modelRequestJournalLeaseBinding };
	}
	return { kind: "self", modelRequestJournalLeaseBinding };
}

export interface SessionModelRequestExecutionInit {
	/** Re-evaluated on every request, so `/new` and session switches never bill a stale id. */
	readonly getSessionId: () => string;
	readonly agent: ModelRequestAgent;
	/**
	 * Where the root comes from, already decided by {@link resolveModelRequestRootSource} at the session boundary.
	 * It is passed through opaquely: this module does not look at the ambient context again, so the decision cannot
	 * drift between where it is made and where it is used.
	 */
	readonly root: ModelRequestRootSource;
}

/** Mint the context of a session being created. */
export function createSessionModelRequestExecution(init: SessionModelRequestExecutionInit): ModelRequestExecution {
	const execution = createModelRequestSessionExecution({
		sessionId: init.getSessionId,
		root: init.root,
		agent: init.agent,
		purpose: init.agent.kind === "main" ? "main" : "subagent",
	});
	return execution;
}

/** The root assignment a session gives to a child it spawns, resolved as of now. */
export function childModelRequestRootOf(execution: ModelRequestExecution): ModelRequestRootAssignment {
	assertJournalExecutionReady(execution);
	return Object.freeze({
		kind: "child",
		rootSessionId: resolveModelRequestScope(execution).rootSessionId,
		modelRequestJournalLeaseBinding: execution.modelRequestJournalLeaseBinding,
		parentExecution: execution,
	});
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
