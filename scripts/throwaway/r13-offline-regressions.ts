import * as path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const ordinary = [
	"packages/ai/test/model-request-transport-hook.test.ts",
	"packages/ai/test/model-request-gate.test.ts",
	"packages/ai/test/model-request-gate-process.test.ts",
	"packages/ai/test/model-request-retry-reasons.test.ts",
	"packages/ai/test/openai-responses-stream-retry.test.ts",
	"packages/ai/test/anthropic-retry.test.ts",
	"packages/ai/test/github-copilot-long-context-wire.test.ts",
	"packages/coding-agent/test/sdk-startup-effects-release.test.ts",
	"packages/coding-agent/test/model-request-context-session.test.ts",
	"packages/coding-agent/test/model-request-site-sends.test.ts",
	"packages/coding-agent/test/model-request-recovery-attempts.test.ts",
	"packages/coding-agent/test/model-request-judge-attempts.test.ts",
	"packages/coding-agent/test/model-request-local-inference.test.ts",
	"packages/coding-agent/test/agent-session-event-order.test.ts",
	"packages/coding-agent/test/extensibility/extension-model-request-context.test.ts",
	"packages/coding-agent/test/extensibility/legacy-pi-session-model-request-root.test.ts",
	"packages/coding-agent/test/task/model-request-root-handover.test.ts",
	"packages/coding-agent/test/task/executor-async-quiescence.test.ts",
	"packages/coding-agent/test/task/executor-deferred-cleanup.test.ts",
	"packages/coding-agent/test/task/executor-launch-startup.test.ts",
	"packages/coding-agent/test/agent-session-memory-backend.test.ts",
	"packages/coding-agent/test/agent-session-dispose-releases-memory.test.ts",
	"packages/coding-agent/test/hindsight-backend.test.ts",
	"packages/coding-agent/test/mnemopi-completion-input.test.ts",
	"packages/coding-agent/test/sharpshooter-backend.test.ts",
	"packages/coding-agent/test/sharpshooter-scheduler-context.test.ts",
	"packages/coding-agent/test/judgment-chain.test.ts",
	"packages/utils/test/model-request-journal-authority-lifetime.test.ts",
	"packages/utils/test/model-request-journal-composition-r11.test.ts",
	"packages/utils/test/model-request-journal-composition-claims.test.ts",
	"packages/utils/test/model-request-journal-outer-work-untracked.test.ts",
	"packages/utils/test/model-request-journal-private-exports.test.ts",
];
interface RegressionResult {
	file: string;
	exitCode: number;
	durationMs: number;
}
const results: RegressionResult[] = [];
const environment: Record<string, string> = {
	PI_TEST_RUNTIME: "1",
	BUN_JSC_useConcurrentGC: "0",
	BUN_JSC_numberOfGCMarkers: "1",
};
for (const key of ["PATH", "HOME", "TMPDIR"] as const) {
	const value = process.env[key];
	if (value !== undefined) environment[key] = value;
}
const suites = [
	...ordinary.map(file => ({ file, preload: false })),
	{ file: "packages/ai/test/model-request-trusted-dispatch.test.ts", preload: true },
];
for (const { file, preload } of suites) {
	const started = performance.now();
	const command = [process.execPath, "test", "--no-orphans"];
	if (preload) command.push("--preload", path.join(root, "scripts/audit-library-bootstrap.ts"));
	command.push(file);
	const child = Bun.spawn(command, {
		cwd: root,
		env: environment,
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
		process.stdout.write(`\n=== ${file} (exit ${exitCode}) ===\n${stdout}`);
		process.stderr.write(stderr);
		results.push({ file, exitCode, durationMs: Math.round(performance.now() - started) });
	} finally {
		if (child.exitCode === null) {
			child.kill("SIGKILL");
			await child.exited;
		}
	}
}
process.stdout.write(`\nREGRESSION_RESULTS ${JSON.stringify(results)}\n`);
process.exitCode = results.some(result => result.exitCode !== 0) ? 1 : 0;
