import "../../../../scripts/audit-library-bootstrap";
import { describe, expect, test } from "bun:test";
import { beginJournalBindingWork, endJournalWork } from "@oh-my-pi/pi-utils/model-request-journal-composition";
import { loadMnemopiModules } from "../../src/mnemopi/state";
import { journalOuterWorkFromBinding } from "../../src/session/internal/outer-work";
import { R11JournalFixture } from "../../../utils/test/fixtures/model-request-journal-r11";

const mac = process.platform === "darwin" ? describe : describe.skip;

async function drainDetachedPromises(tracked: Set<Promise<unknown>>, failures: unknown[]): Promise<void> {
	while (tracked.size > 0) {
		const batch = [...tracked];
		const settled = await Promise.allSettled(batch);
		for (const result of settled) {
			if (result.status === "rejected") failures.push(result.reason);
		}
	}
}

async function runBindingOuterWork(
	binding: Parameters<typeof beginJournalBindingWork>[0],
	work: (track: (promise: Promise<unknown>) => void) => Promise<void>,
): Promise<void> {
	const handle = beginJournalBindingWork(binding);
	const tracked = new Set<Promise<unknown>>();
	const failures: unknown[] = [];
	let primaryError: unknown;
	try {
		await work(promise => {
			tracked.add(promise);
			void promise.finally(() => tracked.delete(promise)).catch(error => failures.push(error));
		});
	} catch (error) {
		primaryError = error;
	}
	await drainDetachedPromises(tracked, failures);
	const error =
		primaryError ??
		(failures.length === 0
			? undefined
			: failures.length === 1
				? failures[0]
				: new AggregateError(failures, "Journal outer work failed"));
	endJournalWork(handle, error === undefined ? { type: "fulfilled" } : { type: "rejected", error });
	if (error !== undefined) throw error;
}

mac("coding-agent outer journal work callers (AC-OL consumer fixtures)", () => {
	test("AC-OL-01/S-01: binding startup work stays open until deferred actual settles", async () => {
		const fixture = new R11JournalFixture();
		try {
			const root = fixture.open();
			await fixture.withBinding(root, async binding => {
				const deferred = Promise.withResolvers<void>();
				let settled = false;
				void deferred.promise.finally(() => {
					settled = true;
				});
				expect(settled).toBe(false);
				await runBindingOuterWork(binding, async track => {
					track(deferred.promise);
					deferred.resolve();
				});
				expect(settled).toBe(true);
			});
		} finally {
			await fixture.close();
		}
	});

	test("AC-OL-05/S-01: rejected outer work preserves child failure for endJournalWork", async () => {
		const fixture = new R11JournalFixture();
		try {
			const root = fixture.open();
			await fixture.withBinding(root, async binding => {
				const childFailure = new Error("deferred startup failure");
				const deferred = Promise.withResolvers<void>();
				deferred.resolve();
				await expect(
					runBindingOuterWork(binding, async track => {
						track(
							deferred.promise.then(() => {
								throw childFailure;
							}),
						);
					}),
				).rejects.toBe(childFailure);
			});
		} finally {
			await fixture.close();
		}
	});

	test("AC-OL-13/S-10: late detached future registered during drain settles before endJournalWork", async () => {
		const fixture = new R11JournalFixture();
		try {
			const root = fixture.open();
			await fixture.withBinding(root, async binding => {
				const scope = journalOuterWorkFromBinding(binding);
				let lateSettled = false;
				const gate = Promise.withResolvers<void>();
				scope.trackDetached(
					gate.promise.then(() => {
						const late = Promise.withResolvers<void>();
						scope.trackDetached(
							late.promise.then(() => {
								lateSettled = true;
							}),
						);
						late.resolve();
					}),
				);
				gate.resolve();
				await scope.complete();
				expect(lateSettled).toBe(true);
			});
		} finally {
			await fixture.close();
		}
	});

	test("AC-OL-14/G-01: withCandidate-scale work aggregates retry futures before end", async () => {
		const fixture = new R11JournalFixture();
		try {
			const root = fixture.open();
			await fixture.withBinding(root, async binding => {
				const first = Promise.withResolvers<void>();
				const second = Promise.withResolvers<void>();
				first.reject(new Error("first candidate failed"));
				second.resolve();
				await expect(
					runBindingOuterWork(binding, async track => {
						track(first.promise);
						track(second.promise);
					}),
				).rejects.toMatchObject({ message: "first candidate failed" });
			});
		} finally {
			await fixture.close();
		}
	});

	test("AC-OL-13/S-07c: dispose-detached consolidate remains on the same open handle", async () => {
		const fixture = new R11JournalFixture();
		try {
			const root = fixture.open();
			await fixture.withBinding(root, async binding => {
				const consolidate = Promise.withResolvers<void>();
				await runBindingOuterWork(binding, async track => {
					track(consolidate.promise);
					consolidate.resolve();
				});
			});
		} finally {
			await fixture.close();
		}
	});

	test("AC-OL-14: Mnemopi parallel module load does not fail-fast discard sibling rejection", async () => {
		await expect(loadMnemopiModules()).resolves.toBeUndefined();
	});
});
