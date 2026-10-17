import "../../../../scripts/audit-library-bootstrap";
import { describe, expect, test } from "bun:test";
import { R11JournalFixture } from "../../../utils/test/fixtures/model-request-journal-r11";
import { journalOuterWorkFromBinding } from "../../src/session/internal/outer-work";

const mac = process.platform === "darwin" ? describe : describe.skip;

/** Flatten an AggregateError chain into its leaf causes. */
function leafCauses(error: unknown): unknown[] {
	const flattened: unknown[] = [];
	const collect = (cause: unknown): void => {
		if (cause instanceof AggregateError) {
			for (const inner of cause.errors) collect(inner);
			return;
		}
		flattened.push(cause);
	};
	collect(error);
	return flattened;
}

mac("coding-agent outer journal work binding contract (utils composition)", () => {
	test("AC-OL-05: rejected outer work preserves child failure for endJournalWork", async () => {
		const fixture = new R11JournalFixture();
		const release = Promise.withResolvers<void>();
		let operation: Promise<void> | undefined;
		const childFailure = new Error("deferred startup failure");
		try {
			const root = fixture.open();
			operation = fixture.withBinding(root, async binding => {
				const deferred = Promise.withResolvers<never>();
				const scope = journalOuterWorkFromBinding(binding);
				scope.trackDetached(deferred.promise);
				deferred.reject(childFailure);
				await release.promise;
				await scope.complete();
			});
			void operation.catch(() => {});
			await Promise.resolve();
			release.resolve();
			const received = await operation.then(
				() => {
					throw new Error("expected the binding operation to reject");
				},
				error => error,
			);
			expect(leafCauses(received)).toContain(childFailure);
		} finally {
			release.resolve();
			await operation?.catch(() => {});
			await fixture.close();
		}
	});

	test("AC-OL-14: withCandidate-scale work aggregates retry futures before end", async () => {
		const fixture = new R11JournalFixture();
		const release = Promise.withResolvers<void>();
		let operation: Promise<void> | undefined;
		const firstFailure = new Error("first candidate failed");
		try {
			const root = fixture.open();
			operation = fixture.withBinding(root, async binding => {
				const first = Promise.withResolvers<never>();
				const scope = journalOuterWorkFromBinding(binding);
				scope.trackDetached(first.promise);
				scope.trackDetached(Promise.resolve());
				first.reject(firstFailure);
				await release.promise;
				await scope.complete();
			});
			void operation.catch(() => {});
			await Promise.resolve();
			release.resolve();
			const received = await operation.then(
				() => {
					throw new Error("expected the binding operation to reject");
				},
				error => error,
			);
			const causes = leafCauses(received);
			expect(causes).toContain(firstFailure);
			expect(causes.some(cause => cause instanceof Error && cause.message === "first candidate failed")).toBe(
				true,
			);
		} finally {
			release.resolve();
			await operation?.catch(() => {});
			await fixture.close();
		}
	});
});
