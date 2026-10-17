import "../../../../scripts/audit-library-bootstrap";
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { beginJournalExecutionWork, createJournalExecution } from "../../src/model-request-journal-composition";

// Fresh process only: journalRequired must stay false. Do not import R11JournalFixture.ready here.
test("beginJournalExecutionWork returns undefined for a genuine untracked execution", () => {
	const untracked = createJournalExecution({
		agent: { id: randomUUID(), kind: "main", name: "untracked-only", depth: 0 },
		purpose: "main",
	});
	expect(beginJournalExecutionWork(untracked)).toBeUndefined();
});
