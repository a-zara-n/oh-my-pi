import { describe, expect, test } from "bun:test";

const FIXTURE = `${import.meta.dir}/fixtures/model-request-gate-process.ts`;

interface ProcessResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

async function runScenario(scenario: string): Promise<ProcessResult> {
	const child = Bun.spawn([process.execPath, FIXTURE, scenario], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, stdout, stderr };
}

/** Parse the fixture's single JSON line, failing with the child's stderr when it did not run. */
function observed(result: ProcessResult): Record<string, unknown> {
	if (result.exitCode !== 0) throw new Error(`fixture exited ${result.exitCode}: ${result.stderr}`);
	const parsed: unknown = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "");
	if (typeof parsed !== "object" || parsed === null) throw new Error(`unexpected fixture output: ${result.stdout}`);
	return Object.fromEntries(Object.entries(parsed));
}

describe("process-wide gate behavior", () => {
	test("with no gate registered a request through the real entry reaches the transport once, unchanged", async () => {
		const result = observed(await runScenario("unregistered"));

		expect(result).toEqual({ wire: 1, stopReason: "stop", registered: false });
	});

	for (const mode of ["none", "pass", "deny"]) {
		test(`managed execution without authenticated composition cannot reach real transports with gate mode ${mode}`, async () => {
			const result = observed(await runScenario(`managed-${mode}`));
			expect(result).toEqual({
				sinklessWire: 1,
				managedWire: 0,
				customStarts: 0,
				gateCalls: 0,
				refused: Array.from({ length: 10 }, () => true),
				registered: mode !== "none",
			});
		});
	}

	test("a second copy of the runtime module cannot register a different gate, so a duplicate pi-ai cannot unguard the host", async () => {
		const result = observed(await runScenario("shared-latch"));

		expect(result.registeredSeenByPublicApi).toBe(true);
		expect(result.secondCopyRegistrationError).toMatch(/already registered/);
		expect(result.publicRegistrationError).toMatch(/already registered/);
	});
});
