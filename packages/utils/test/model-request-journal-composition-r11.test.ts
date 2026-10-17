import { test } from "bun:test";
import { runNativeJournalSuite } from "./helpers/model-request-journal-suite";

test(
	"native journal r11 composition (isolated process)",
	() => runNativeJournalSuite("model-request-journal-composition-r11.suite.ts"),
	150_000,
);
