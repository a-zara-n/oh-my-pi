import { test } from "bun:test";
import { runNativeJournalSuite } from "./helpers/model-request-journal-suite";

test(
	"native journal composition claims (isolated process)",
	() => runNativeJournalSuite("model-request-journal-composition-claims.suite.ts"),
	150_000,
);
