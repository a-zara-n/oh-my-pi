import "../../../../scripts/audit-library-bootstrap";
import { describe, expect, test } from "bun:test";
import { journalOuterWorkFromBinding } from "../../src/session/internal/outer-work";
import { R11JournalFixture } from "../../../utils/test/fixtures/model-request-journal-r11";

const mac = process.platform === "darwin" ? describe : describe.skip;

mac("coding-agent outer journal work binding contract (utils composition)", () => {
	test("AC-OL-05: rejected outer work preserves child failure for endJournalWork", async () => {
		const fixture = new R11JournalFixture();
		try {
			const root = fixture.open();
			await fixture.withBinding(root, async binding => {
				const childFailure = new Error("deferred startup failure");
				const deferred = Promise.withResolvers<void>();
				deferred.resolve();
				const scope = journalOuterWorkFromBinding(binding);
				scope.trackDetached(
					deferred.promise.then(() => {
						throw childFailure;
					}),
				);
				await expect(scope.complete()).rejects.toBe(childFailure);
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
				const scope = journalOuterWorkFromBinding(binding);
				scope.trackDetached(first.promise);
				scope.trackDetached(second.promise);
				await expect(scope.complete()).rejects.toMatchObject({ message: "first candidate failed" });
			});
		} finally {
			await fixture.close();
		}
	});
});
