/**
 * Package-private outer journal work scopes for coding-agent canonical producers.
 * Not a package export (`package.json` denies this subpath); import only via relative paths.
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

class JournalOuterWorkScope {
	readonly #handle: JournalWorkHandle | undefined;
	readonly #tracked = new Set<Promise<unknown>>();
	#failures: unknown[] = [];
	#ended = false;

	constructor(handle: JournalWorkHandle | undefined) {
		this.#handle = handle;
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

const noopJournalOuterWorkScope = new JournalOuterWorkScope(undefined);

export function journalOuterWorkFromBinding(
	binding: ModelRequestJournalLeaseBinding | undefined,
): JournalOuterWorkScope {
	if (binding === undefined) return noopJournalOuterWorkScope;
	return new JournalOuterWorkScope(beginJournalBindingWork(binding));
}

export function journalOuterWorkFromExecution(execution: ModelRequestExecution | undefined): JournalOuterWorkScope {
	if (execution === undefined) return noopJournalOuterWorkScope;
	const handle = beginJournalExecutionWork(execution);
	if (handle === undefined) return noopJournalOuterWorkScope;
	return new JournalOuterWorkScope(handle);
}

export type { JournalOuterWorkScope };
