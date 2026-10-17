import * as path from "node:path";
import { test } from "bun:test";

async function runManagedJournalSuite(fixtureName: string): Promise<void> {
	const root = path.resolve(import.meta.dir, "../../..");
	const bootstrap = path.join(root, "scripts/audit-library-bootstrap.ts");
	const fixture = path.resolve(import.meta.dir, "fixtures", fixtureName);
	const child = Bun.spawn([process.execPath, "test", "--no-orphans", "--preload", bootstrap, fixture], {
		cwd: root,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: 180_000,
	});
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (stdout) process.stdout.write(stdout);
		if (stderr) process.stderr.write(stderr);
		if (exitCode !== 0) throw new Error(`${fixtureName} exited ${exitCode}`);
	} finally {
		if (child.exitCode === null) {
			child.kill("SIGKILL");
			await child.exited;
		}
	}
}

test(
	"journal outer work binding contract (isolated managed process)",
	() => runManagedJournalSuite("journal-outer-work-callers.suite.ts"),
	150_000,
);

test(
	"journal outer work canonical source callers (isolated managed process)",
	() => runManagedJournalSuite("journal-outer-work-source-callers.suite.ts"),
	180_000,
);
