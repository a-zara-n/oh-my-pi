/**
 * Package-private outer journal work bridge for fixed subsystems (memory, SDK startup).
 * Not exported from the package entry; consumers must not reach arbitrary callbacks through AgentSession.
 */
import type { AgentSession } from "../agent-session";

export interface AgentSessionOuterWorkBridge {
	run<T>(work: () => Promise<T>): Promise<T>;
	trackDetached(promise: Promise<unknown>): void;
	noteFailure(error: unknown): void;
	beginDetached(): AgentSessionDetachedOuterWork;
}

/**
 * A journal work handle begun while the binding still accepted work and settled
 * later with the raw producer future. Acquire it before starting the producer —
 * a binding that closes in between refuses new begins, and the raw future must
 * already have its accounting home so settlement never needs a new begin.
 */
export interface AgentSessionDetachedOuterWork {
	settle(promise: Promise<unknown>, onError: (error: unknown) => void): void;
}

/** Observe a raw future for a session without a journal bridge. */
export function observeDetachedOuterWork(promise: Promise<unknown>, onError: (error: unknown) => void): void {
	void promise.then(
		() => {},
		error => onError(error),
	);
}

const agentSessionOuterWorkBridgeKey = Symbol("agentSessionOuterWorkBridge");

export function bindAgentSessionOuterWorkBridge(session: AgentSession, bridge: AgentSessionOuterWorkBridge): void {
	Object.defineProperty(session, agentSessionOuterWorkBridgeKey, {
		value: bridge,
		enumerable: false,
		configurable: false,
		writable: false,
	});
}

function outerWorkBridge(session: AgentSession): AgentSessionOuterWorkBridge | undefined {
	return (session as { [agentSessionOuterWorkBridgeKey]?: AgentSessionOuterWorkBridge })[
		agentSessionOuterWorkBridgeKey
	];
}

export function runAgentSessionOuterWork<T>(session: AgentSession, work: () => Promise<T>): Promise<T> {
	const bridge = outerWorkBridge(session);
	if (bridge === undefined) return work();
	return bridge.run(work);
}

export function trackAgentSessionOuterWork(session: AgentSession, promise: Promise<unknown>): void {
	outerWorkBridge(session)?.trackDetached(promise);
}

/** Record an unrecovered failure on the session's active outer-work scope, when one is open. */
export function noteAgentSessionOuterWorkFailure(session: AgentSession, error: unknown): void {
	outerWorkBridge(session)?.noteFailure(error);
}

/**
 * Begin a self-contained journal work handle for a producer the consumer will not
 * await, so the caller keeps its bounded return. Acquire this before starting the
 * producer: a binding that moved to closing in between refuses new begins.
 * Sessions without a journal bridge observe the future directly. `settle` holds
 * the raw promise on the open handle for its full lifetime, with `onError` observing the accounted
 * rejection (journal `end` happens first), so a void call site never turns it into
 * an unhandled fatal.
 */
export function beginDetachedAgentSessionOuterWork(session: AgentSession): AgentSessionDetachedOuterWork {
	const bridge = outerWorkBridge(session);
	if (bridge === undefined) return { settle: observeDetachedOuterWork };
	return bridge.beginDetached();
}
