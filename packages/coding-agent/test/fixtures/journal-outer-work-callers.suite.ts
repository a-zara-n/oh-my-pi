import "../../../../scripts/audit-library-bootstrap";
import { describe, expect, test } from "bun:test";
import { beginJournalBindingWork, endJournalWork } from "@oh-my-pi/pi-utils/model-request-journal-composition";
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

mac("coding-agent outer journal work binding contract (utils composition)", () => {
	test("AC-OL-05: rejected outer work preserves child failure for endJournalWork", async () => {
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

	test("AC-OL-14: withCandidate-scale work aggregates retry futures before end", async () => {
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
});
