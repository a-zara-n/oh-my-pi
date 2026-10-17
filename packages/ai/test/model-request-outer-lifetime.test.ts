import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../..");
const FIXTURE = path.join(import.meta.dir, "fixtures/model-request-outer-lifetime-process.ts");
const BOOTSTRAP = path.join(ROOT, "scripts/audit-library-bootstrap.ts");

const SCENARIOS: ReadonlyArray<{
	readonly name: string;
	readonly rows: readonly string[];
	readonly expect: (value: Record<string, unknown>) => void;
}> = [
	{
		name: "gate-late-allow-settle-pending",
		rows: ["E-02", "AC-OL-03"],
		expect: v => {
			expect(v.late).toBe("pending");
			expect(v.settledCount).toBe(1);
		},
	},
	{
		name: "gate-late-allow-settle-reject",
		rows: ["E-02", "AC-OL-03"],
		expect: v => {
			expect(v.settledCount).toBe(1);
			expect(v.rejectMessage).toBe("late unused lease settle failed");
		},
	},
	{
		name: "gate-abort-late-allow",
		rows: ["E-02", "AC-OL-03"],
		expect: v => {
			expect(v.settled).toEqual({ type: "not-sent", aborted: true });
		},
	},
	{
		name: "gate-decision-unrecognizable",
		rows: ["E-02", "AC-OL-14"],
		expect: v => {
			expect(v.message).toContain("unrecognizable");
		},
	},
	{
		name: "gate-deny-outer-rejected",
		rows: ["E-02", "AC-OL-02"],
		expect: v => {
			expect(v.denied).toBe(true);
			expect(v.closeError).toBeDefined();
		},
	},
	{
		name: "pass-body-hold-until-read",
		rows: ["E-01", "AC-OL-02", "AC-OL-06"],
		expect: v => {
			expect(v.blockedBeforeRead).toBe("pending");
		},
	},
	{
		name: "pass-body-cancel-reject",
		rows: ["E-01", "AC-OL-06"],
		expect: v => {
			expect(v.cancelled).toBe(true);
		},
	},
	{
		name: "dispatch-sync-throw-joins-response",
		rows: ["E-01", "AC-OL-06"],
		expect: v => {
			expect(v.observed).toBe(1);
			expect(v.failure).toContain("sync throw after dispatch started");
		},
	},
	{
		name: "guarded-settle-reentry",
		rows: ["E-02", "AC-OL-14"],
		expect: v => {
			expect(v.settled).toEqual([{ type: "response-ended", status: 200 }]);
		},
	},
	{
		name: "guarded-transfer-cleanup-on-settle-reject",
		rows: ["E-02", "AC-OL-14"],
		expect: v => {
			expect(v.settleRejected).toBe(true);
			expect(v.closeError).toBeDefined();
		},
	},
	{
		name: "gate-authorize-throws-outer-end",
		rows: ["E-02", "AC-OL-14"],
		expect: v => {
			expect(v.sendFailed).toBe(true);
		},
	},
	{
		name: "a01-tf-debug-holds-wire",
		rows: ["A-01", "E-01", "AC-OL-10"],
		expect: v => {
			expect(v.wireBefore).toBe(0);
			expect(v.closeRace).toBe("pending");
		},
	},
	{
		name: "a02-inflight-heartbeat-flush-pending",
		rows: ["A-02", "AC-OL-12"],
		expect: v => {
			expect(v.blockedBeforeClose).toBe("pending");
		},
	},
	{
		name: "a02-inflight-remove-lease-reject",
		rows: ["A-02", "AC-OL-12"],
		expect: v => {
			expect(v.closeError).toBeDefined();
		},
	},
	{
		name: "a02-inflight-release-joins-raw",
		rows: ["A-02", "AC-OL-12"],
		expect: v => {
			expect(v.blocked).toBe("pending");
			expect(v.calls).toBe(2);
		},
	},
	{
		name: "a03-header-resolver-pending",
		rows: ["A-03", "AC-OL-12"],
		expect: v => {
			expect(v.pending).toBe("pending");
		},
	},
	{
		name: "a03-header-resolver-reject",
		rows: ["A-03", "AC-OL-12"],
		expect: v => {
			expect(v.failure).toBe(true);
		},
	},
	{
		name: "a04-auth-retry-recovered-fulfilled",
		rows: ["A-04", "AC-OL-12", "AC-OL-14"],
		expect: v => {
			expect(v.stopReason).toBe("stop");
			expect(v.wireAttempts).toBeGreaterThanOrEqual(2);
		},
	},
	{
		name: "a04-auth-retry-unrecovered-rejected",
		rows: ["A-04", "AC-OL-12", "AC-OL-14"],
		expect: v => {
			expect(v.failed).toBe(true);
			expect(v.closeError).toBeDefined();
		},
	},
	{
		name: "a05-uninstrumented-wrapper-pending",
		rows: ["A-05", "AC-OL-12"],
		expect: v => {
			expect(v.pending).toBe("pending");
		},
	},
	{
		name: "a06-leaked-thinking-inner-pending",
		rows: ["A-06", "AC-OL-12"],
		expect: v => {
			expect(v.pending).toBe("pending");
		},
	},
	{
		name: "a06-thinking-loop-inner-pending",
		rows: ["A-06", "AC-OL-12"],
		expect: v => {
			expect(v.pending).toBe("pending");
		},
	},
];

async function runScenario(name: string): Promise<Record<string, unknown>> {
	const child = Bun.spawn([process.execPath, "--preload", BOOTSTRAP, FIXTURE, name], {
		cwd: ROOT,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: 90_000,
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
