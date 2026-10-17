import "../../../scripts/audit-library-bootstrap";
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	retainVerifiedModelRequestJournalRoot,
	retireModelRequestWriterCredential,
	type ModelRequestJournalRetainedRootScope,
} from "../src/model-request-journal-authority";
import {
	appendJournalMetadata,
	type FileJournalCell,
} from "../src/model-request-journal-composition";
import { tryAcquireRawModelRequestJournalFileLease } from "../src/model-request-journal-leases";
import type { ModelRequestRegistryEntry } from "../src/session-entries";
import { R11JournalFixture } from "./fixtures/model-request-journal-r11";

const mac = process.platform === "darwin" ? describe : describe.skip;

function assertExclusiveLease(filename: string, held: boolean): void {
	const uid = process.getuid?.();
	if (uid === undefined) throw new Error("Missing actual test uid");
	const acquired = tryAcquireRawModelRequestJournalFileLease(filename, "exclusive", uid);
	try { expect(acquired === undefined).toBe(held); }
	finally { acquired?.release(); }
}

function closedSessions(root: FileJournalCell): string[] {
	return root.getEntries()
		.filter((entry): entry is ModelRequestRegistryEntry => entry.type === "model_request_registry")
		.filter(entry => entry.record.event === "owner-closed")
		.map(entry => entry.record.sessionId);
}

mac("authority private binding lifetime with actual File principals", () => {
	test("callbacks without principals preserve return values and the exact rejection", async () => {
		const fixture = new R11JournalFixture();
		try {
			const root = fixture.open();
			const result = Object.freeze({ result: "unchanged" });
			expect(await fixture.withBinding(root, async () => result)).toBe(result);
			const failure = new Error("original callback failure");
			await expect(fixture.withBinding(root, async () => { throw failure; })).rejects.toBe(failure);
		} finally { await fixture.close(); }
	});

	test("original use retains real leases until settlement, then closes actual child graphs before release", async () => {
		const fixture = new R11JournalFixture();
		const entered = Promise.withResolvers<ModelRequestJournalRetainedRootScope>();
		const useSettlement = Promise.withResolvers<void>();
		let operation: Promise<string> | undefined;
		try {
			const root = fixture.open();
			const child = fixture.open();
			operation = fixture.withBinding(root, async binding => {
				const parent = await fixture.ready(binding, root);
				await fixture.ready(binding, child, parent);
				const retained = retainVerifiedModelRequestJournalRoot(binding, "lifetime-use");
				entered.resolve(retained);
				await useSettlement.promise;
				return "settled";
			});
			void operation.catch(error => entered.reject(error));
			const retained = await entered.promise;
			retained.assertActive();
			expect(closedSessions(root)).toEqual([]);
			assertExclusiveLease(path.join(fixture.namespace, "accounting/lifetime-use.lock"), true);
			useSettlement.resolve();
			expect(await operation).toBe("settled");
			expect(new Set(closedSessions(root))).toEqual(new Set([root.getSessionId(), child.getSessionId()]));
			expect(() => retained.assertHeld()).toThrow();
			assertExclusiveLease(path.join(fixture.namespace, "accounting/lifetime-use.lock"), false);
			const durable = fs.readFileSync(root.getSessionFile(), "utf8");
			expect(durable).toContain('"event":"member-closed"');
			expect(durable).toContain('"event":"owner-closed"');
		} finally {
			useSettlement.resolve();
			try { await operation; } finally { await fixture.close(); }
		}
	});

	test("rejected use still drains accepted metadata and every actual descendant before releasing roots", async () => {
		const fixture = new R11JournalFixture();
		const failure = new Error("reject after actual queue admission");
		const accepted: Promise<unknown>[] = [];
		let retained: ModelRequestJournalRetainedRootScope | undefined;
		try {
			const root = fixture.open();
			const child = fixture.open();
			const deep = fixture.open();
			const operation = fixture.withBinding(root, async binding => {
				const parent = await fixture.ready(binding, root);
				const childPrincipal = await fixture.ready(binding, child, parent);
				const descendant = await fixture.ready(binding, deep, childPrincipal, undefined, root);
				retained = retainVerifiedModelRequestJournalRoot(binding, "lifetime-rejected-use");
				for (const principal of [parent, childPrincipal, descendant]) {
					const append = appendJournalMetadata(principal.session, principal.execution, {
						schemaVersion: 1, event: "decision", coreAttemptId: randomUUID(), requestId: randomUUID(),
						coreRetryOf: null, rootSessionId: root.getSessionId(), sessionId: principal.cell.getSessionId(),
						purpose: "main", modelRef: { provider: "openai", id: "fixture-model", api: "openai-completions" },
						atMs: 1, decision: "pass",
					});
					accepted.push(append);
					// Observe an immediate rejection without replacing or detaching the real operation.
					void append.catch(() => {});
				}
				throw failure;
			});
			await expect(operation).rejects.toBe(failure);
			const results = await Promise.allSettled(accepted);
			expect(results).toHaveLength(3);
			expect(results.every(result => result.status === "fulfilled")).toBe(true);
			expect(new Set(closedSessions(root))).toEqual(new Set([root.getSessionId(), child.getSessionId(), deep.getSessionId()]));
			for (const cell of [root, child, deep]) {
				expect(cell.getEntries().filter(entry => entry.type === "model_request_metadata")).toHaveLength(1);
				expect(fs.readFileSync(cell.getSessionFile(), "utf8")).toContain('"event":"decision"');
			}
			expect(retained).toBeDefined();
			expect(() => retained?.assertHeld()).toThrow();
			assertExclusiveLease(path.join(fixture.namespace, "accounting/lifetime-rejected-use.lock"), false);
		} finally {
			await Promise.allSettled(accepted);
			await fixture.close();
		}
	});

	test("genuine credential retirement remains a drain failure alongside the exact callback rejection", async () => {
		const fixture = new R11JournalFixture();
		const failure = new Error("original callback failure before retirement");
		let retained: ModelRequestJournalRetainedRootScope | undefined;
		try {
			const root = fixture.open();
			let combined: unknown;
			try {
				await fixture.withBinding(root, async binding => {
					const parent = await fixture.ready(binding, root);
					await fixture.ready(binding, fixture.open(), parent);
					retained = retainVerifiedModelRequestJournalRoot(binding, "lifetime-retired");
					retireModelRequestWriterCredential(fixture.requester);
					throw failure;
				});
			} catch (error) { combined = error; }
			expect(combined).toBeInstanceOf(AggregateError);
			if (!(combined instanceof AggregateError)) throw new Error("Expected operation and drain failures");
			expect(combined.errors[0]).toBe(failure);
			expect(combined.errors[1]).toBeInstanceOf(AggregateError);
			expect(closedSessions(root)).toEqual([]);
			expect(retained).toBeDefined();
			expect(() => retained?.assertHeld()).toThrow();
			assertExclusiveLease(path.join(fixture.namespace, "accounting/lifetime-retired.lock"), false);
		} finally { await fixture.close(); }
	});
});
