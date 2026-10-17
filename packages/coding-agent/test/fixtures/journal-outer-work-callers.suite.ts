import "../../../../scripts/audit-library-bootstrap";
import { describe, expect, test } from "bun:test";
import { JournalOuterWorkOwner } from "../../src/session/journal-outer-work";
import { R11JournalFixture } from "../../../utils/test/fixtures/model-request-journal-r11";

const mac = process.platform === "darwin" ? describe : describe.skip;

mac("coding-agent outer journal work callers (AC-OL consumer fixtures)", () => {
	test("AC-OL-01/S-01: binding startup work stays open until deferred actual settles", async () => {
		const fixture = new R11JournalFixture();
		try {
			const root = fixture.open();
			await fixture.withBinding(root, async binding => {
				const owner = JournalOuterWorkOwner.fromBinding(binding);
				const deferred = Promise.withResolvers<void>();
				owner.trackDetached(deferred.promise);
				let settled = false;
				void deferred.promise.finally(() => {
					settled = true;
				});
				expect(settled).toBe(false);
				deferred.resolve();
				await owner.complete();
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
				const owner = JournalOuterWorkOwner.fromBinding(binding);
				const deferred = Promise.withResolvers<void>();
				owner.trackDetached(
					deferred.promise.then(() => {
						throw childFailure;
					}),
				);
				deferred.resolve();
				await expect(owner.complete()).rejects.toBe(childFailure);
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
				const owner = JournalOuterWorkOwner.fromBinding(binding);
				const first = Promise.withResolvers<void>();
				const second = Promise.withResolvers<void>();
				owner.trackDetached(first.promise);
				owner.trackDetached(second.promise);
				first.reject(new Error("first candidate failed"));
				second.resolve();
				await expect(owner.complete()).rejects.toMatchObject({ message: "first candidate failed" });
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
				const owner = JournalOuterWorkOwner.fromBinding(binding);
				const consolidate = Promise.withResolvers<void>();
				owner.trackDetached(consolidate.promise);
				consolidate.resolve();
				await owner.complete();
			});
		} finally {
			await fixture.close();
		}
	});

	test("AC-OL-14: Mnemopi parallel module load does not fail-fast discard sibling rejection", async () => {
		const { loadMnemopiModules } = await import("../../src/mnemopi/state");
		await expect(loadMnemopiModules()).resolves.toBeUndefined();
	});
});
