import { test } from "bun:test";
import { runNativeJournalSuite } from "./helpers/model-request-journal-suite";

test(
	"native journal authority lifetime (isolated process)",
	() => runNativeJournalSuite("model-request-journal-authority-lifetime.suite.ts"),
	150_000,
);
