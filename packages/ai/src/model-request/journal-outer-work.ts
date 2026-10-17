/**
 * @internal DES-004 §6.7.2i — managed execution outer work only.
 * Lives under `src/model-request/` (not `src/*.ts` top-level) so `package.json` `"./*"`
 * does not publish this module as a subpath.
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

export interface ManagedOuterWorkScope {
	readonly active: boolean;
	track<T>(promise: Promise<T>): Promise<T>;
	noteFailure(error: unknown): void;
	transfer(): void;
	abortTransfer(): void;
	end(): Promise<void>;
	endTransferred(): Promise<void>;
}

function aggregateFailures(failures: readonly unknown[]): unknown {
	if (failures.length === 0) return new Error("journal outer work failed without a reason");
	if (failures.length === 1) return failures[0];
	return new AggregateError([...failures], "journal outer work failed");
}

const inactiveOuterWork: ManagedOuterWorkScope = {
	active: false,
	track: promise => promise,
	noteFailure() {},
	transfer() {},
	abortTransfer() {},
	end: async () => {},
	endTransferred: async () => {},
};

class ActiveOuterWorkScope implements ManagedOuterWorkScope {
	readonly active = true;
	readonly #handle: JournalWorkHandle;
	readonly #failures: unknown[] = [];
	readonly #joined = new Set<Promise<unknown>>();
	#ended = false;
	#transferred = false;

	constructor(handle: JournalWorkHandle) {
		this.#handle = handle;
	}

	noteFailure(error: unknown): void {
		this.#failures.push(error);
	}

	/** Join settlement without treating rejection as a journal failure (DES-004 §6.7.2i recovered retry). */
	track<T>(promise: Promise<T>): Promise<T> {
		const join = promise.then(
			() => undefined as unknown,
			() => undefined as unknown,
		);
		this.#joined.add(join);
		void join.finally(() => this.#joined.delete(join));
		return promise;
	}

	transfer(): void {
		if (this.#ended || this.#transferred) return;
		this.#transferred = true;
	}

	abortTransfer(): void {
		if (this.#ended) return;
		if (this.#transferred) this.#transferred = false;
	}

	async end(): Promise<void> {
		if (this.#ended || this.#transferred) return;
		await Promise.allSettled([...this.#joined]);
		this.#finish();
	}

	async endTransferred(): Promise<void> {
		if (this.#ended || !this.#transferred) return;
		await Promise.allSettled([...this.#joined]);
		this.#finish();
	}

	#finish(): void {
		if (this.#ended) return;
		this.#ended = true;
		const outcome: JournalWorkOutcome =
			this.#failures.length === 0
				? { type: "fulfilled" }
				: { type: "rejected", error: aggregateFailures(this.#failures) };
		endJournalWork(this.#handle, outcome);
	}
}

/** Journal `begin`/`end` only for genuine managed executions; untracked is a zero-cost pass-through. */
export function beginManagedExecutionOuterWork(
	execution: ModelRequestExecution | undefined,
): ManagedOuterWorkScope {
	if (execution === undefined || execution.journalState === "untracked") return inactiveOuterWork;
	assertJournalExecutionReady(execution);
	const handle = beginJournalExecutionWork(execution);
	if (handle === undefined) return inactiveOuterWork;
	return new ActiveOuterWorkScope(handle);
}

export function beginManagedOuterWorkFromCurrent(): ManagedOuterWorkScope {
	return beginManagedExecutionOuterWork(getModelRequestRuntime().currentExecution());
}

/** Join sync or async work under managed outer accounting; untracked is a plain await. */
export async function awaitManagedOuterWork<T>(
	scope: ManagedOuterWorkScope,
	work: Promise<T> | T,
): Promise<T> {
	const promise = Promise.resolve(work);
	return scope.active ? scope.track(promise) : promise;
}
