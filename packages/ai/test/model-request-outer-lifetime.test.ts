import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../..");
const FIXTURE = path.join(import.meta.dir, "fixtures/model-request-outer-lifetime-process.ts");
const BOOTSTRAP = path.join(ROOT, "scripts/audit-library-bootstrap.ts");

/**
 * AC-OL-02/03/06/10/12/14 consumer-visible regressions (parent executes).
 *
 * Each case is a fresh managed-only subprocess with audit bootstrap. Never mix
 * normal untracked journal proofs or `installFixtureGate` in-process work with
 * these native managed scenarios (required latch / gate registration are not reversible).
 */
const SCENARIOS: ReadonlyArray<{
	readonly name: string;
	readonly rows: readonly string[];
	readonly expect: (value: Record<string, unknown>) => void;
}> = [
	{
		name: "gate-late-allow-settle-pending",
		rows: ["E-02", "AC-OL-03"],
		expect: value => {
			expect(value.late).toBe("pending");
			expect(value.settledCount).toBe(1);
		},
	},
	{
		name: "gate-late-allow-settle-reject",
		rows: ["E-02", "AC-OL-03"],
		expect: value => {
			expect(value.settledCount).toBe(1);
			expect(value.rejectMessage).toBe("late unused lease settle failed");
		},
	},
	{
		name: "gate-abort-late-allow",
		rows: ["E-02", "AC-OL-03"],
		expect: value => {
			expect(value.settled).toEqual({ type: "not-sent", aborted: true });
		},
	},
	{
		name: "pass-body-hold-until-read",
		rows: ["E-01", "AC-OL-02", "AC-OL-06"],
		expect: value => {
			expect(value.blockedBeforeRead).toBe("pending");
		},
	},
	{
		name: "pass-body-cancel-reject",
		rows: ["E-01", "AC-OL-06"],
		expect: value => {
			expect(value.cancelled).toBe(true);
		},
	},
	{
		name: "dispatch-sync-throw-joins-response",
		rows: ["E-01", "AC-OL-06"],
		expect: value => {
			expect(value.observed).toBe(1);
			expect(value.failure).toContain("sync throw after dispatch started");
		},
	},
	{
		name: "guarded-settle-reentry",
		rows: ["E-02", "AC-OL-14"],
		expect: value => {
			expect(value.settled).toEqual([{ type: "response-ended", status: 200 }]);
		},
	},
	{
		name: "guarded-transfer-cleanup-on-settle-reject",
		rows: ["E-02", "AC-OL-14"],
		expect: value => {
			expect(value.failure).toBe(true);
		},
	},
];

async function runScenario(name: string): Promise<Record<string, unknown>> {
	const child = Bun.spawn([process.execPath, "--preload", BOOTSTRAP, FIXTURE, name], {
		cwd: ROOT,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: 60_000,
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect({ name, exitCode, stderr }).toEqual({ name, exitCode: 0, stderr: "" });
	const parsed: unknown = JSON.parse(stdout.trim());
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`unexpected fixture output for ${name}: ${stdout}`);
	}
	return parsed as Record<string, unknown>;
}

describe("model request outer producer lifetime (managed subprocess)", () => {
	for (const scenario of SCENARIOS) {
		test(`${scenario.name} [${scenario.rows.join(", ")}]`, async () => {
			scenario.expect(await runScenario(scenario.name));
		});
	}
});

/**
 * Additional AC-OL-10/12 cases wired in source; parent should extend fixture coverage:
 * - A-01 TF debug hold before gatedSend (transport-fetch required + PI_REQ_DEBUG)
 * - A-02 provider in-flight heartbeat/remove/waiter timeout pending/reject (provider-inflight.test.ts seam)
 * - A-03 header raw resolver pending/reject after untilAborted (withResolvedModelHeaders)
 * - A-04 apiKey resolver + auth retry IIFE (streamSimpleRequest)
 * - A-05 gateUninstrumentedTransport wrapper IIFE
 * - A-06 thinking-loop / leaked-thinking transfer IIFE
 * - A-07 stream/streamSimple do not end on result() alone (lower canonical owners)
 */
