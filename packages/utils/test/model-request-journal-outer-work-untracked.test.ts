import { test } from "bun:test";
import { runNativeJournalSuite } from "./helpers/model-request-journal-suite";

test(
	"native journal outer work untracked (isolated process)",
	() => runNativeJournalSuite("model-request-journal-outer-work-untracked.suite.ts"),
	150_000,
);
