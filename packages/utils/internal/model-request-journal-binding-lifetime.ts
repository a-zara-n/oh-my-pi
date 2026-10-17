import type { ModelRequestJournalLeaseBinding } from "../src/model-request-journal-authority";

interface PrincipalDrain {
	readonly drain: () => Promise<void>;
}

interface OuterWorkEntry {
	settled: boolean;
	readonly settlement: Promise<void>;
	readonly resolveSettlement: () => void;
	failures: unknown[];
}

interface BindingLifetime {
	phase: "open" | "closing" | "drained" | "ended";
	readonly principals: Map<object, PrincipalDrain>;
	readonly outerWorks: Map<object, OuterWorkEntry>;
	assertLive?: () => void;
	join?: Promise<void>;
	outerJoin?: Promise<void>;
}

// This is lifetime ownership, not binding authentication. Only the authority's
// private genuine-binding producer initializes it, after recording that binding.
const lifetimes = new WeakMap<ModelRequestJournalLeaseBinding, BindingLifetime>();
const principalBindings = new WeakMap<object, ModelRequestJournalLeaseBinding>();
const activeJournalWorkHandles = new WeakMap<
	object,
	{ readonly binding: ModelRequestJournalLeaseBinding; readonly entry: OuterWorkEntry }
>();

function lifetimeOf(binding: ModelRequestJournalLeaseBinding): BindingLifetime {
	const lifetime = lifetimes.get(binding);
	if (!lifetime) throw new Error("Journal binding unverified");
	return lifetime;
}

export function initializeBindingLifetime(binding: ModelRequestJournalLeaseBinding): void {
	if (!binding || typeof binding !== "object" || lifetimes.has(binding)) {
		throw new Error("Journal binding lifetime initialization rejected");
	}
	lifetimes.set(binding, { phase: "open", principals: new Map(), outerWorks: new Map() });
}

export function connectBindingWorkAuth(
	binding: ModelRequestJournalLeaseBinding,
	assertLive: () => void,
): void {
	const lifetime = lifetimeOf(binding);
	if (lifetime.assertLive !== undefined || typeof assertLive !== "function") {
		throw new Error("Journal binding work authentication rejected");
	}
	lifetime.assertLive = assertLive;
}

export function registerBindingPrincipal(
	binding: ModelRequestJournalLeaseBinding,
	principal: object,
	drain: () => Promise<void>,
): void {
	const lifetime = lifetimeOf(binding);
	if (lifetime.phase !== "open" || !principal || typeof principal !== "object" || typeof drain !== "function") {
		throw new Error("Journal binding no longer accepts work");
	}
	const previousBinding = principalBindings.get(principal);
	if (previousBinding !== undefined && previousBinding !== binding) {
		throw new Error("Journal principal binding replacement rejected");
	}
	const previous = lifetime.principals.get(principal);
	if (previous) {
		if (previous.drain !== drain) throw new Error("Journal principal drain replacement rejected");
		return;
	}
	principalBindings.set(principal, binding);
	lifetime.principals.set(principal, { drain });
}

export function registerJournalOuterWork(binding: ModelRequestJournalLeaseBinding, handle: object): void {
	let lifetime: BindingLifetime;
	try {
		lifetime = lifetimeOf(binding);
	} catch (error) {
		throw error;
	}
	if (lifetime.phase !== "open") throw new Error("Journal binding no longer accepts work");
	if (lifetime.assertLive === undefined) throw new Error("Journal binding unverified");
	lifetime.assertLive();
	if (!handle || typeof handle !== "object" || activeJournalWorkHandles.has(handle) || lifetime.outerWorks.has(handle)) {
		throw new Error("Journal work handle rejected");
	}
	const { promise, resolve } = Promise.withResolvers<void>();
	const entry: OuterWorkEntry = {
		settled: false,
		settlement: promise,
		resolveSettlement: resolve,
		failures: [],
	};
	lifetime.outerWorks.set(handle, entry);
	activeJournalWorkHandles.set(handle, { binding, entry });
}

export function settleJournalOuterWork(handle: object, outcome: { readonly type: "fulfilled" } | { readonly type: "rejected"; readonly error: unknown }): void {
	const active = activeJournalWorkHandles.get(handle);
	if (!active) throw new Error("Journal work handle rejected");
	const lifetime = lifetimes.get(active.binding);
	const entry = lifetime?.outerWorks.get(handle);
	if (!lifetime || !entry || entry !== active.entry || entry.settled) {
		throw new Error("Journal work handle rejected");
	}
	entry.settled = true;
	if (outcome.type === "rejected") entry.failures.push(outcome.error);
	activeJournalWorkHandles.delete(handle);
	entry.resolveSettlement();
}

export function beginClosingBindingLifetime(binding: ModelRequestJournalLeaseBinding): void {
	const lifetime = lifetimeOf(binding);
	if (lifetime.phase === "open") lifetime.phase = "closing";
}

export function joinBindingOuterWorkDrains(binding: ModelRequestJournalLeaseBinding): Promise<void> {
	const lifetime = lifetimeOf(binding);
	if (lifetime.phase === "open" || lifetime.phase === "ended") {
		throw new Error("Journal binding outer work drain phase rejected");
	}
	if (lifetime.outerJoin) return lifetime.outerJoin;
	lifetime.outerJoin = (async () => {
		const failures: unknown[] = [];
		const waits = new Set<Promise<void>>();
		for (const entry of lifetime.outerWorks.values()) {
			waits.add(entry.settlement);
		}
		const settled = await Promise.allSettled(waits);
		for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
		for (const entry of lifetime.outerWorks.values()) {
			if (entry.failures.length > 0) failures.push(...entry.failures);
		}
		if (failures.length > 0) throw new AggregateError(failures, "Journal outer work drains failed");
	})();
	return lifetime.outerJoin;
}

export function joinBindingPrincipalDrains(binding: ModelRequestJournalLeaseBinding): Promise<void> {
	const lifetime = lifetimeOf(binding);
	if (lifetime.phase === "open" || lifetime.phase === "ended") {
		throw new Error("Journal binding drain phase rejected");
	}
	if (lifetime.join) return lifetime.join;
	lifetime.join = (async () => {
		const drains = new Set<Promise<void>>();
		const failures: unknown[] = [];
		for (const { drain } of lifetime.principals.values()) {
			try {
				drains.add(drain());
			} catch (error) {
				failures.push(error);
			}
		}
		const settled = await Promise.allSettled(drains);
		lifetime.phase = "drained";
		for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
		if (failures.length > 0) throw new AggregateError(failures, "Journal principal drains failed");
	})();
	return lifetime.join;
}

export function finishBindingLifetime(binding: ModelRequestJournalLeaseBinding): void {
	const lifetime = lifetimeOf(binding);
	if (lifetime.phase !== "drained") throw new Error("Journal binding has unsettled principal drains");
	lifetime.phase = "ended";
	lifetime.principals.clear();
	lifetime.outerWorks.clear();
}
