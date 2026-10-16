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
import type { ModelRequestJournalLeaseBinding } from "@oh-my-pi/pi-utils/model-request-journal-authority";
import type { ModelRequestJournal } from "./session-manager";

const executionJournals = new WeakMap<ModelRequestExecution, { journal: ModelRequestJournal | undefined }>();

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
	if (
		activeExecution?.modelRequestJournalLeaseBinding !== undefined &&
		modelRequestJournalLeaseBinding !== activeExecution.modelRequestJournalLeaseBinding
	) {
		throw new Error("a managed child must explicitly retain its parent's model request journal binding");
	}
	if (assignment !== undefined) {
		return { kind: "inherited", rootSessionId: assignment.rootSessionId, modelRequestJournalLeaseBinding };
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
	/** Only transports the SDK's private sink slot; never passed to ai as trusted readiness. */
	readonly journalConnection?: Promise<ModelRequestJournal>;
}

/** Mint the context of a session being created. */
export function createSessionModelRequestExecution(init: SessionModelRequestExecutionInit): ModelRequestExecution {
	const journalSlot: { journal: ModelRequestJournal | undefined } | undefined =
		init.journalConnection === undefined ? undefined : { journal: undefined };
	const journalConnection = init.journalConnection?.then(journal => {
		if (journalSlot === undefined) throw new Error("model request execution journal slot is unavailable");
		journalSlot.journal = journal;
	});
	// A failed composition is also awaited by the SDK; do not leave an unobserved rejection on the execution.
	void journalConnection?.catch(() => {});
	const execution = createModelRequestSessionExecution({
		sessionId: init.getSessionId,
		root: init.root,
		agent: init.agent,
		purpose: init.agent.kind === "main" ? "main" : "subagent",
	});
	if (journalSlot !== undefined) executionJournals.set(execution, journalSlot);
	return execution;
}

/** The root assignment a session gives to a child it spawns, resolved as of now. */
export function childModelRequestRootOf(execution: ModelRequestExecution): ModelRequestRootAssignment {
	const journalSlot = executionJournals.get(execution);
	if (journalSlot !== undefined && journalSlot.journal === undefined) {
		throw new Error("model request execution journal is not connected");
	}
	return {
		kind: "child",
		rootSessionId: resolveModelRequestScope(execution).rootSessionId,
		modelRequestJournalLeaseBinding: execution.modelRequestJournalLeaseBinding,
	};
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
	const journalSlot = executionJournals.get(execution);
	if (journalSlot !== undefined && scoped !== execution) executionJournals.set(scoped, journalSlot);
	return (model, context, options) => runWithModelRequestExecution(scoped, () => streamFn(model, context, options));
}
