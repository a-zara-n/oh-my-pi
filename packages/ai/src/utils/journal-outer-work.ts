/**
 * @internal DES-004 §6.7.2i / E+A caller outer work accounting. Not exported from the package.
 */
import {
	assertJournalExecutionReady,
	beginJournalExecutionWork,
	endJournalWork,
	type JournalWorkHandle,
	type JournalWorkOutcome,
	type ModelRequestExecution,
} from "@oh-my-pi/pi-utils/model-request-journal-composition";
import { getModelRequestRuntime } from "../model-request-runtime";

function aggregateFailures(failures: readonly unknown[]): unknown {
	if (failures.length === 0) return new Error("journal outer work failed without a reason");
	if (failures.length === 1) return failures[0];
	return new AggregateError([...failures], "journal outer work failed");
}

/** Owns one `beginJournalExecutionWork` registration until `end` or transfer to {@link GuardedLease}. */
export class ExecutionOuterWorkScope {
	readonly #handle: JournalWorkHandle | undefined;
	readonly #failures: unknown[] = [];
	readonly #joined = new Set<Promise<unknown>>();
	#ended = false;
	#transferred = false;

	private constructor(handle: JournalWorkHandle | undefined) {
		this.#handle = handle;
	}

	static begin(execution: ModelRequestExecution | undefined): ExecutionOuterWorkScope {
		if (execution === undefined) return new ExecutionOuterWorkScope(undefined);
		assertJournalExecutionReady(execution);
		const handle = beginJournalExecutionWork(execution);
		return new ExecutionOuterWorkScope(handle);
	}

	get active(): boolean {
		return this.#handle !== undefined && !this.#ended && !this.#transferred;
	}

	noteFailure(error: unknown): void {
		this.#failures.push(error);
	}

	track<T>(promise: Promise<T>): Promise<T> {
		if (!this.active) return promise;
		const tracked = promise.catch(error => {
			this.#failures.push(error);
			throw error;
		});
		const join = tracked.then(
			() => undefined as unknown,
			() => undefined as unknown,
		);
		this.#joined.add(join);
		void join.finally(() => this.#joined.delete(join));
		return tracked;
	}

	transfer(): void {
		if (this.#handle === undefined || this.#ended || this.#transferred) return;
		this.#transferred = true;
	}

	async end(): Promise<void> {
		if (this.#handle === undefined || this.#ended) return;
		if (this.#transferred) return;
		await Promise.allSettled([...this.#joined]);
		this.#finish();
	}

	async endTransferred(): Promise<void> {
		if (this.#handle === undefined || this.#ended) return;
		if (!this.#transferred) return;
		await Promise.allSettled([...this.#joined]);
		this.#finish();
	}

	#finish(): void {
		if (this.#handle === undefined || this.#ended) return;
		this.#ended = true;
		const outcome: JournalWorkOutcome =
			this.#failures.length === 0
				? { type: "fulfilled" }
				: { type: "rejected", error: aggregateFailures(this.#failures) };
		endJournalWork(this.#handle, outcome);
	}
}

export function beginCurrentExecutionOuterWork(): ExecutionOuterWorkScope {
	const execution = getModelRequestRuntime().currentExecution();
	return ExecutionOuterWorkScope.begin(execution);
}
