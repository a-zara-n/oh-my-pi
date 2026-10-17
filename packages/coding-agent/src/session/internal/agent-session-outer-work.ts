/**
 * Package-private outer journal work bridge for fixed subsystems (memory, SDK startup).
 * Not exported from the package entry; consumers must not reach arbitrary callbacks through AgentSession.
 */
import type { AgentSession } from "../agent-session";

export interface AgentSessionOuterWorkBridge {
	run<T>(work: () => Promise<T>): Promise<T>;
	trackDetached(promise: Promise<unknown>): void;
	noteFailure(error: unknown): void;
	detachObserved(promise: Promise<unknown>, onError: (error: unknown) => void): void;
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
 * Own a detached producer on a self-contained journal work handle that the consumer does
 * not await: the caller keeps its bounded return while the raw promise stays held on the
 * open handle until settlement. `onError` observes the rejection after the journal `end`
 * accounting, so a void call site never turns it into an unhandled fatal.
 */
export function detachAgentSessionOuterWork(
	session: AgentSession,
	promise: Promise<unknown>,
	onError: (error: unknown) => void,
): void {
	const bridge = outerWorkBridge(session);
	if (bridge === undefined) {
		void promise.then(
			() => {},
			error => onError(error),
		);
		return;
	}
	bridge.detachObserved(promise, onError);
}
