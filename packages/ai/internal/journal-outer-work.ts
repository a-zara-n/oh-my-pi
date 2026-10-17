/**
 * Package-private journal outer work (DES-004 §6.7.2i). Not a public subpath:
 * `package.json` denies `./internal/*`. Canonical callers assert execution readiness
 * before `openJournalOuterWork`; this module does not re-assert or reject required-pending.
 */
import {
	beginJournalExecutionWork,
	endJournalWork,
	type JournalWorkHandle,
	type JournalWorkOutcome,
	type ModelRequestExecution,
} from "@oh-my-pi/pi-utils/model-request-journal-composition";
import { getModelRequestRuntime } from "../src/model-request-runtime";

function aggregateFailures(failures: readonly unknown[]): unknown {
	if (failures.length === 0) return new Error("journal outer work failed without a reason");
	if (failures.length === 1) return failures[0];
	return new AggregateError([...failures], "journal outer work failed");
}

/** Opaque managed outer-work registration; no methods exported on a public subpath. */
export class JournalOuterWork {
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

	/** Join actual futures; rejections are not journal failures unless explicitly noted (recovered retry). */
	join<T>(promise: Promise<T>): Promise<T> {
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
		await this.#drainJoined();
		this.#finish();
	}

	async endTransferred(): Promise<void> {
		if (this.#ended || !this.#transferred) return;
		await this.#drainJoined();
		this.#finish();
	}

	async #drainJoined(): Promise<void> {
		while (this.#joined.size > 0) {
			const batch = [...this.#joined];
			await Promise.allSettled(batch);
		}
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

export function openJournalOuterWork(execution: ModelRequestExecution | undefined): JournalOuterWork | undefined {
	if (execution === undefined || execution.journalState === "untracked") return undefined;
	const handle = beginJournalExecutionWork(execution);
	if (handle === undefined) return undefined;
	return new JournalOuterWork(handle);
}

export function openJournalOuterWorkFromCurrent(): JournalOuterWork | undefined {
	return openJournalOuterWork(getModelRequestRuntime().currentExecution());
}

export async function joinJournalOuterWork<T>(
	work: JournalOuterWork | undefined,
	workOrPromise: Promise<T> | T,
): Promise<T> {
	const promise = Promise.resolve(workOrPromise);
	return work === undefined ? promise : work.join(promise);
}
