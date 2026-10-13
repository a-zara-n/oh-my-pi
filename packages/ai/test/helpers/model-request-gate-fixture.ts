import {
	type ModelRequestAttempt,
	type ModelRequestDecision,
	type ModelRequestGate,
	registerModelRequestGate,
} from "../../src/model-request-gate";

/**
 * A registered gate cannot be removed (latch), so a test process registers ONE fixture gate and swaps what it
 * answers per test. It answers `pass` until a test sets a handler, and records every attempt it is asked about.
 */
export type FixtureGateHandler = (attempt: ModelRequestAttempt) => ModelRequestDecision | Promise<ModelRequestDecision>;

export interface FixtureGate {
	/** Answer subsequent attempts with `handler`. */
	setHandler(handler: FixtureGateHandler): void;
	/** Back to `pass`, and forget recorded attempts. Call from `beforeEach`/`afterEach`. */
	reset(): void;
	/** Attempts the gate was asked about since the last `reset()`. */
	readonly attempts: readonly ModelRequestAttempt[];
}

const PASS: FixtureGateHandler = () => ({ type: "pass" });

class FixtureGateImpl implements FixtureGate, ModelRequestGate {
	#handler: FixtureGateHandler = PASS;
	readonly #attempts: ModelRequestAttempt[] = [];

	get attempts(): readonly ModelRequestAttempt[] {
		return this.#attempts;
	}

	setHandler(handler: FixtureGateHandler): void {
		this.#handler = handler;
	}

	reset(): void {
		this.#handler = PASS;
		this.#attempts.length = 0;
	}

	async authorize(attempt: ModelRequestAttempt): Promise<ModelRequestDecision> {
		this.#attempts.push(attempt);
		return this.#handler(attempt);
	}
}

const fixture = new FixtureGateImpl();

/** Register the shared fixture gate (idempotent) and return its controller. */
export function installFixtureGate(): FixtureGate {
	registerModelRequestGate("test-fixture", fixture);
	return fixture;
}
