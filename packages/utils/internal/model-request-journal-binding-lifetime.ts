import type { ModelRequestJournalLeaseBinding } from "../src/model-request-journal-authority";

interface PrincipalDrain {
	readonly drain: () => Promise<void>;
}
interface BindingLifetime {
	phase: "open" | "closing" | "drained" | "ended";
	readonly principals: Map<object, PrincipalDrain>;
	join?: Promise<void>;
}

// This is lifetime ownership, not binding authentication. Only the authority's
// private genuine-binding producer initializes it, after recording that binding.
const lifetimes = new WeakMap<ModelRequestJournalLeaseBinding, BindingLifetime>();
const principalBindings = new WeakMap<object, ModelRequestJournalLeaseBinding>();

function lifetimeOf(binding: ModelRequestJournalLeaseBinding): BindingLifetime {
	const lifetime = lifetimes.get(binding);
	if (!lifetime) throw new Error("Journal binding unverified");
	return lifetime;
}

export function initializeBindingLifetime(binding: ModelRequestJournalLeaseBinding): void {
	if (!binding || typeof binding !== "object" || lifetimes.has(binding)) {
		throw new Error("Journal binding lifetime initialization rejected");
	}
	lifetimes.set(binding, { phase: "open", principals: new Map() });
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

export function beginClosingBindingLifetime(binding: ModelRequestJournalLeaseBinding): void {
	const lifetime = lifetimeOf(binding);
	if (lifetime.phase === "open") lifetime.phase = "closing";
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
}
