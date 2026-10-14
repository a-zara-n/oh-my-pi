import { Buffer } from "node:buffer";
import {
	type ModelRequestAttempt,
	type ModelRequestDecision,
	type ModelRequestGate,
	type ModelRequestLease,
	type ModelRequestOutcome,
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

/** What a lease was told, in order. */
export type RecordedLeaseEvent =
	| { readonly type: "beginSend" }
	| { readonly type: "observeResponse"; readonly status: number; readonly headers: Readonly<Record<string, string>> }
	| { readonly type: "observeChunk"; readonly bytes: Uint8Array }
	| { readonly type: "settle"; readonly outcome: ModelRequestOutcome };

export interface RecordingLease {
	readonly lease: ModelRequestLease;
	readonly events: readonly RecordedLeaseEvent[];
	/** The outcomes passed to `settle`, in call order. */
	readonly settled: readonly ModelRequestOutcome[];
	/** Every observed chunk, concatenated. */
	observedBytes(): Uint8Array;
	/** Resolves with the first outcome passed to `settle`. */
	readonly firstSettle: Promise<ModelRequestOutcome>;
}

/**
 * A lease that records the protocol it is driven through. `trace` additionally receives `beginSend`,
 * `observeResponse` and `settle` as they happen, so a test can order them against other recorded events.
 */
export function recordingLease(trace?: string[]): RecordingLease {
	const events: RecordedLeaseEvent[] = [];
	const settled: ModelRequestOutcome[] = [];
	const first = Promise.withResolvers<ModelRequestOutcome>();
	const lease: ModelRequestLease = {
		beginSend() {
			events.push({ type: "beginSend" });
			trace?.push("beginSend");
		},
		observeResponse(head) {
			events.push({ type: "observeResponse", status: head.status, headers: head.headers });
			trace?.push("observeResponse");
		},
		observeChunk(bytes) {
			events.push({ type: "observeChunk", bytes });
		},
		async settle(outcome) {
			events.push({ type: "settle", outcome });
			settled.push(outcome);
			trace?.push("settle");
			first.resolve(outcome);
		},
	};
	return {
		lease,
		events,
		settled,
		observedBytes() {
			const chunks = events.flatMap(event => (event.type === "observeChunk" ? [event.bytes] : []));
			return Buffer.concat(chunks);
		},
		firstSettle: first.promise,
	};
}
