import * as path from "node:path";
import { test } from "bun:test";

/** Isolated managed-process suite for AC-OL coding-agent caller wiring (parent runs). */
async function runJournalOuterWorkCallersSuite(): Promise<void> {
	const root = path.resolve(import.meta.dir, "../../..");
	const bootstrap = path.join(root, "scripts/audit-library-bootstrap.ts");
	const fixture = path.resolve(import.meta.dir, "fixtures/journal-outer-work-callers.suite.ts");
	const child = Bun.spawn([process.execPath, "test", "--no-orphans", "--preload", bootstrap, fixture], {
		cwd: root,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: 120_000,
	});
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (stdout) process.stdout.write(stdout);
		if (stderr) process.stderr.write(stderr);
		if (exitCode !== 0) throw new Error(`journal-outer-work-callers suite exited ${exitCode}`);
	} finally {
		if (child.exitCode === null) {
			child.kill("SIGKILL");
			await child.exited;
		}
	}
}

test("journal outer work SDK callers (isolated managed process)", () => runJournalOuterWorkCallersSuite(), 150_000);
