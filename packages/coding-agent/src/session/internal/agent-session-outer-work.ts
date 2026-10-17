/**
 * Package-private outer journal work bridge for fixed subsystems (memory, SDK startup).
 * Not exported from the package entry; consumers must not reach arbitrary callbacks through AgentSession.
 */
import type { AgentSession } from "../agent-session";

export interface AgentSessionOuterWorkBridge {
	run<T>(work: () => Promise<T>): Promise<T>;
	trackDetached(promise: Promise<unknown>): void;
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
