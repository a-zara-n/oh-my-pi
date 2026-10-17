// Loader-order exception, matching scripts/audit-library-bootstrap.ts: the native-only
// scenario must select pinned SQLite before evaluating the fixture's application graph.
if (process.argv[2] === "genuine-parent") {
	await import("../../../../scripts/audit-library-bootstrap");
}
await import("./model-request-context-journal-probe-body");

export {};
