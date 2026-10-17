/**
 * Source-owned outer journal work for coding-agent canonical producers.
 *
 * @internal
 */
import type { ModelRequestExecution } from "@oh-my-pi/pi-ai/model-request-execution";
import type { ModelRequestJournalLeaseBinding } from "@oh-my-pi/pi-utils/model-request-journal-authority";
import {
	beginJournalBindingWork,
	beginJournalExecutionWork,
	endJournalWork,
	type JournalWorkHandle,
} from "@oh-my-pi/pi-utils/model-request-journal-composition";

function combineJournalWorkErrors(errors: unknown[]): unknown | undefined {
	const failures = errors.filter(error => error !== undefined);
	if (failures.length === 0) return undefined;
	if (failures.length === 1) return failures[0];
	return new AggregateError(failures, "Journal outer work failed");
}

export class JournalOuterWorkOwner {
	readonly #handle: JournalWorkHandle | undefined;
	readonly #tracked = new Set<Promise<unknown>>();
	#failures: unknown[] = [];
	#ended = false;

	private constructor(handle: JournalWorkHandle | undefined) {
		this.#handle = handle;
	}

	static fromBinding(binding: ModelRequestJournalLeaseBinding | undefined): JournalOuterWorkOwner {
		if (binding === undefined) return new JournalOuterWorkOwner(undefined);
		return new JournalOuterWorkOwner(beginJournalBindingWork(binding));
	}

	static fromExecution(execution: ModelRequestExecution | undefined): JournalOuterWorkOwner {
		if (execution === undefined) return new JournalOuterWorkOwner(undefined);
		return new JournalOuterWorkOwner(beginJournalExecutionWork(execution));
	}

	get active(): boolean {
		return this.#handle !== undefined && !this.#ended;
	}

	noteFailure(error: unknown): void {
		if (!this.active || error === undefined) return;
		this.#failures.push(error);
	}

	trackDetached(promise: Promise<unknown>): void {
		if (!this.active) return;
		this.#tracked.add(promise);
		void promise.finally(() => this.#tracked.delete(promise)).catch(error => {
			this.#failures.push(error);
		});
	}

	async complete(primaryError?: unknown): Promise<void> {
		if (this.#handle === undefined || this.#ended) {
			if (primaryError !== undefined) throw primaryError;
			return;
		}
		this.#ended = true;
		const failures = [...this.#failures];
		if (primaryError !== undefined) failures.push(primaryError);
		const settled = await Promise.allSettled([...this.#tracked]);
		for (const result of settled) {
			if (result.status === "rejected") failures.push(result.reason);
		}
		const error = combineJournalWorkErrors(failures);
		endJournalWork(this.#handle, error === undefined ? { type: "fulfilled" } : { type: "rejected", error });
		if (error !== undefined) throw error;
	}

	async run<T>(work: () => Promise<T>): Promise<T> {
		if (this.#handle === undefined) return work();
		try {
			const result = await work();
			await this.complete();
			return result;
		} catch (error) {
			await this.complete(error);
			throw error;
		}
	}
}

export async function runJournalOuterWorkFromBinding<T>(
	binding: ModelRequestJournalLeaseBinding | undefined,
	work: () => Promise<T>,
): Promise<T> {
	return JournalOuterWorkOwner.fromBinding(binding).run(work);
}

export async function runJournalOuterWorkFromExecution<T>(
	execution: ModelRequestExecution | undefined,
	work: () => Promise<T>,
): Promise<T> {
	return JournalOuterWorkOwner.fromExecution(execution).run(work);
}
