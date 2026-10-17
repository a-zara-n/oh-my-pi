/**
 * Canonical-producer outer journal scopes (package-internal only).
 * `package.json` denies `./session/internal/*`; import via relative paths within this package.
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

/**
 * Wait for every detached future; late registrations during settlement stay in the set
 * until empty. Failures are recorded at settle time by `trackDetached`, so a promise
 * that settles (and unregisters) before `complete` drains still keeps its failure.
 */
async function drainDetachedPromises(tracked: Set<Promise<unknown>>): Promise<void> {
	while (tracked.size > 0) {
		await Promise.allSettled([...tracked]);
	}
}

export interface JournalOuterWorkScope {
	readonly active: boolean;
	noteFailure(error: unknown): void;
	trackDetached(promise: Promise<unknown>): void;
	complete(primaryError?: unknown): Promise<void>;
	run<T>(work: () => Promise<T>): Promise<T>;
}

class JournalOuterWorkScopeImpl implements JournalOuterWorkScope {
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
		// Keep rejections off the unhandled-rejection path until the journal end
		// accounting observes them, and record the failure at settle time so a
		// promise that unregisters before `complete` still keeps its cause.
		void promise.catch(() => undefined);
		void promise.then(
			() => this.#tracked.delete(promise),
			error => {
				this.noteFailure(error);
				this.#tracked.delete(promise);
			},
		);
	}

	async complete(primaryError?: unknown): Promise<void> {
		if (this.#handle === undefined || this.#ended) {
			if (primaryError !== undefined) throw primaryError;
			return;
		}
		await drainDetachedPromises(this.#tracked);
		this.#ended = true;
		// Snapshot only after the drain: a failure noted while the last tracked
		// future settles (late registration, SDK activation) must still reach the
		// terminal outcome instead of the pre-drain copy.
		const failures = [...this.#failures];
		if (primaryError !== undefined) failures.push(primaryError);
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

const noopJournalOuterWorkScope: JournalOuterWorkScope = new JournalOuterWorkScopeImpl(undefined);

export function journalOuterWorkFromBinding(
	binding: ModelRequestJournalLeaseBinding | undefined,
): JournalOuterWorkScope {
	if (binding === undefined) return noopJournalOuterWorkScope;
	return new JournalOuterWorkScopeImpl(beginJournalBindingWork(binding));
}

export function journalOuterWorkFromExecution(execution: ModelRequestExecution | undefined): JournalOuterWorkScope {
	if (execution === undefined) return noopJournalOuterWorkScope;
	const handle = beginJournalExecutionWork(execution);
	if (handle === undefined) return noopJournalOuterWorkScope;
	return new JournalOuterWorkScopeImpl(handle);
}
