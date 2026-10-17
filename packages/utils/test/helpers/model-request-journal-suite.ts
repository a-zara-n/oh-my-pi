import * as path from "node:path";

type NativeJournalSuite =
	| "model-request-journal-authority-lifetime.suite.ts"
	| "model-request-journal-composition-r11.suite.ts"
	| "model-request-journal-composition-claims.suite.ts"
	| "model-request-journal-outer-work-untracked.suite.ts";

/** Keep the real managed-process latch out of the ordinary test runner. */
export async function runNativeJournalSuite(suite: NativeJournalSuite): Promise<void> {
	const root = path.resolve(import.meta.dir, "../../../..");
	const bootstrap = path.join(root, "scripts/audit-library-bootstrap.ts");
	const fixture = path.resolve(import.meta.dir, "../fixtures", suite);
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
		// Retain the child runner's individual cases, assertion failures and
		// counts, including successful runs; the parent only owns its boundary.
		if (stdout) process.stdout.write(stdout);
		if (stderr) process.stderr.write(stderr);
		if (exitCode !== 0) throw new Error(`Native journal suite ${suite} exited ${exitCode}`);
	} finally {
		if (child.exitCode === null) {
			child.kill("SIGKILL");
			await child.exited;
		}
	}
}
