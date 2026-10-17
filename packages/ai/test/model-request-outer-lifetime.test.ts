import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../..");
const FIXTURE = path.join(import.meta.dir, "fixtures/model-request-outer-lifetime-process.ts");
const BOOTSTRAP = path.join(ROOT, "scripts/audit-library-bootstrap.ts");
const RELEASE_FAULT = path.join(import.meta.dir, "fixtures/outer-lifetime-release-fault-preload.ts");
const CHILD_TIMEOUT_MS = 90_000;
const PARENT_TIMEOUT_MS = 120_000;

interface ScenarioSpec {
	readonly name: string;
	readonly rows: readonly string[];
	readonly expect: (value: Record<string, unknown>) => void;
	/** Extra `--preload` modules for this child (scenario-specific fault injection). */
	readonly preloads?: readonly string[];
	/** Override the child's working directory (e.g. a read-only dir for debug-file failures). */
	readonly cwd?: "readonly";
}

/** AC-OL-02: while the close is held, the owner's exclusive lease is unavailable; after settlement it is again. */
function expectLeaseHoldEvidence(v: Record<string, unknown>): void {
	expect(v.ownerExclusiveDuringHold).toBe(false);
	expect(v.ownerExclusiveAfterClose).toBe(true);
}

const SCENARIOS: readonly ScenarioSpec[] = [
	{
		name: "gate-late-allow-settle-pending",
		rows: ["E-02", "AC-OL-03"],
		expect: v => {
			expect(v.late).toBe("pending");
			expect(v.settledCount).toBe(1);
			expect(v.authorityRejected).toBe(true);
			expect(v.authorityPreservesCause).toBe(true);
		},
	},
	{
		name: "gate-late-allow-settle-reject",
		rows: ["E-02", "AC-OL-03"],
		expect: v => {
			expect(v.settledCount).toBe(1);
			expect(v.rejectMessage).toBe("late unused lease settle failed");
			expect(v.authorityRejected).toBe(true);
			expect(v.authorityPreservesCause).toBe(true);
		},
	},
	{
		name: "gate-abort-late-allow",
		rows: ["E-02", "AC-OL-03"],
		expect: v => {
			expect(v.settled).toEqual({ type: "not-sent", aborted: true });
			expect(v.authorityRejected).toBe(true);
			expect(v.authorityPreservesCause).toBe(true);
		},
	},
	{
		name: "gate-decision-unrecognizable",
		rows: ["E-01", "E-02", "AC-OL-05", "AC-OL-14"],
		expect: v => {
			expect(v.message).toContain("unrecognizable");
			expect(v.authorityRejected).toBe(true);
			expect(v.authorityPreservesCause).toBe(true);
		},
	},
	{
		name: "gate-deny-outer-rejected",
		rows: ["E-01", "E-02", "AC-OL-05"],
		expect: v => {
			expect(v.denied).toBe(true);
			expect(v.authorityRejected).toBe(true);
			expect(v.authorityPreservesCause).toBe(true);
		},
	},
	{
		name: "pass-body-hold-until-read",
		rows: ["E-01", "AC-OL-02", "AC-OL-06"],
		expect: v => {
			expect(v.blockedBeforeRead).toBe("pending");
			expect(v.bindingActiveDuringRace).toBe(true);
			expectLeaseHoldEvidence(v);
			expect(v.bodyText).toContain("hello");
			expect(v.authorityOk).toBe(true);
		},
	},
	{
		name: "required-transport-unsupported-outer-end",
		rows: ["E-01", "E-02", "AC-OL-05"],
		expect: v => {
			expect(v.failed).toBe(true);
			expect(v.wireAttempts).toBe(0);
			expect(v.authorityRejected).toBe(true);
			expect(v.authorityPreservesCause).toBe(true);
		},
	},
	{
		name: "pass-body-cancel-reject",
		rows: ["E-01", "AC-OL-06"],
		expect: v => {
			expect(v.cancelled).toBe(true);
			expect(v.authorityOk).toBe(true);
		},
	},
	{
		name: "dispatch-sync-throw-joins-response",
		rows: ["E-01", "AC-OL-06"],
		preloads: [RELEASE_FAULT],
		expect: v => {
			expect(v.observed).toBe(1);
			expect(v.failure).toContain("sync throw after dispatch started");
			expect(v.authorityRejected).toBe(true);
			expect(v.authorityPreservesCause).toBe(true);
		},
	},
	{
		name: "e02-guarded-concurrent-settle-reentry",
		rows: ["E-02", "AC-OL-14"],
		expect: v => {
			expect(v.settled).toEqual([{ type: "response-ended", status: 200 }]);
			expect(v.concurrentSettleJoined).toBe(true);
			expect(v.authorityOk).toBe(true);
		},
	},
	{
		name: "guarded-transfer-cleanup-on-settle-reject",
		rows: ["E-02", "AC-OL-14"],
		expect: v => {
			expect(v.settleRejected).toBe(true);
			expect(v.authorityRejected).toBe(true);
		},
	},
	{
		name: "gate-authorize-throws-outer-end",
		rows: ["E-01", "E-02", "AC-OL-05", "AC-OL-14"],
		expect: v => {
			expect(v.sendFailed).toBe(true);
			expect(v.authorityRejected).toBe(true);
			expect(v.authorityPreservesCause).toBe(true);
		},
	},
	{
		name: "a01-tf-debug-holds-wire",
		rows: ["A-01", "E-01", "AC-OL-02", "AC-OL-10"],
		expect: v => {
			expect(v.wireBefore).toBe(0);
			expect(v.authorityRace).toBe("pending");
			expect(v.bindingActiveDuringRace).toBe(true);
			expectLeaseHoldEvidence(v);
			expect(v.authorityOk).toBe(true);
		},
	},
	{
		name: "a01-tf-debug-reject",
		rows: ["A-01", "AC-OL-05", "AC-OL-10"],
		cwd: "readonly",
		expect: v => {
			expect(v.debugFailed).toBe(true);
			expect(v.wireAttempts).toBe(0);
			expect(v.authorityRejected).toBe(true);
			expect(v.authorityPreservesCause).toBe(true);
		},
	},
	{
		name: "a02-inflight-heartbeat-flush-pending",
		rows: ["A-02", "AC-OL-02", "AC-OL-12"],
		expect: v => {
			expect(v.authorityRace).toBe("pending");
			expect(v.bindingActiveDuringRace).toBe(true);
			expect(v.osLeaseCountDuringRace).toBeGreaterThanOrEqual(1);
			expectLeaseHoldEvidence(v);
			expect(v.authorityOk).toBe(true);
		},
	},
	{
		name: "a02-inflight-heartbeat-flush-reject",
		rows: ["A-02", "AC-OL-12"],
		expect: v => {
			expect(v.authorityRejected).toBe(true);
		},
	},
	{
		name: "a02-inflight-remove-lease-pending",
		rows: ["A-02", "AC-OL-02", "AC-OL-12"],
		expect: v => {
			expect(v.authorityRace).toBe("pending");
			expect(v.osLeaseCountDuringRace).toBeGreaterThanOrEqual(1);
			expectLeaseHoldEvidence(v);
			expect(v.authorityOk).toBe(true);
		},
	},
	{
		name: "a02-inflight-remove-lease-reject",
		rows: ["A-02", "AC-OL-12"],
		expect: v => {
			expect(v.authorityRejected).toBe(true);
		},
	},
	{
		name: "a02-inflight-waiter-pending",
		rows: ["A-02", "AC-OL-02", "AC-OL-12"],
		expect: v => {
			expect(v.authorityRace).toBe("pending");
			expect(v.osLeaseCountDuringRace).toBeGreaterThanOrEqual(1);
			expectLeaseHoldEvidence(v);
			expect(v.authorityOk).toBe(true);
		},
	},
	{
		name: "a02-inflight-waiter-abort",
		rows: ["A-02", "AC-OL-12"],
		expect: v => {
			expect(v.waiterFailed).toBe(true);
			expect(v.authorityRace).toBe("pending");
			expectLeaseHoldEvidence(v);
			expect(v.authorityRejected).toBe(true);
			expect(v.authorityPreservesCause).toBe(true);
		},
	},
	{
		name: "a02-inflight-waiter-reject",
		rows: ["A-02", "AC-OL-12"],
		expect: v => {
			expect(v.requestsCompleted).toBe(true);
			expect(v.authorityRejected).toBe(true);
			expect(v.authorityPreservesCause).toBe(true);
		},
	},
	{
		name: "a02-inflight-release-joins-raw",
		rows: ["A-02", "AC-OL-02", "AC-OL-12"],
		expect: v => {
			expect(v.authorityRace).toBe("pending");
			expect(v.osLeaseCountDuringRace).toBeGreaterThanOrEqual(2);
			expect(v.calls).toBe(2);
			expectLeaseHoldEvidence(v);
			expect(v.authorityOk).toBe(true);
		},
	},
	{
		name: "a03-header-resolver-pending",
		rows: ["A-03", "AC-OL-02", "AC-OL-12"],
		expect: v => {
			expect(v.authorityRace).toBe("pending");
			expectLeaseHoldEvidence(v);
			expect(v.authorityOk).toBe(true);
		},
	},
	{
		name: "a03-header-resolver-reject",
		rows: ["A-03", "AC-OL-12", "AC-OL-14"],
		expect: v => {
			expect(v.rootCauseSeen).toBe(true);
			expect(v.authorityOk).toBe(false);
			expect(v.authorityPreservesRootCause).toBe(true);
		},
	},
	{
		name: "a04-auth-retry-recovered-fulfilled",
		rows: ["A-04", "AC-OL-12", "AC-OL-14"],
		expect: v => {
			expect(v.stopReason).toBe("stop");
			expect(v.wireAttempts).toBeGreaterThanOrEqual(2);
			expect(v.authorityOk).toBe(true);
		},
	},
	{
		name: "a04-auth-retry-unrecovered-rejected",
		rows: ["A-04", "AC-OL-12", "AC-OL-14"],
		expect: v => {
			expect(v.failed).toBe(true);
			expect(v.authorityOk).toBe(false);
			expect(v.authorityPreservesStreamFailure).toBe(true);
		},
	},
	{
		name: "a05-uninstrumented-wrapper-pending",
		rows: ["A-05", "AC-OL-02", "AC-OL-12"],
		expect: v => {
			expect(v.authorityRace).toBe("pending");
			expectLeaseHoldEvidence(v);
			expect(v.authorityOk).toBe(true);
		},
	},
	{
		name: "a06-leaked-thinking-inner-pending",
		rows: ["A-06", "AC-OL-02", "AC-OL-12"],
		expect: v => {
			expect(v.authorityRace).toBe("pending");
			expectLeaseHoldEvidence(v);
			expect(v.authorityOk).toBe(true);
		},
	},
	{
		name: "a06-thinking-loop-inner-pending",
		rows: ["A-06", "AC-OL-02", "AC-OL-12"],
		expect: v => {
			expect(v.authorityRace).toBe("pending");
			expectLeaseHoldEvidence(v);
			expect(v.authorityOk).toBe(true);
		},
	},
];

async function runScenario(spec: ScenarioSpec): Promise<Record<string, unknown>> {
	const args = [process.execPath];
	for (const preload of [BOOTSTRAP, ...(spec.preloads ?? [])]) args.push("--preload", preload);
	args.push(FIXTURE, spec.name);
	let readonlyDir: string | undefined;
	if (spec.cwd === "readonly") {
		readonlyDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ol-readonly-cwd-"));
		fs.chmodSync(readonlyDir, 0o500);
	}
	const child = Bun.spawn(args, {
		cwd: readonlyDir ?? ROOT,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: CHILD_TIMEOUT_MS,
	});
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (exitCode !== 0) {
			throw new Error(
				`scenario ${spec.name} exited ${exitCode}\nstderr:\n${stderr}\nstdout:\n${stdout}`,
			);
		}
		const parsed: unknown = JSON.parse(stdout.trim());
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error(`unexpected fixture output for ${spec.name}: ${stdout}\nstderr:\n${stderr}`);
		}
		return parsed as Record<string, unknown>;
	} finally {
		if (child.exitCode === null) {
			child.kill("SIGKILL");
			await child.exited;
		}
		if (readonlyDir !== undefined) fs.rmSync(readonlyDir, { recursive: true, force: true });
	}
}

describe("model request outer producer lifetime (managed subprocess)", () => {
	for (const scenario of SCENARIOS) {
		test(
			`${scenario.name} [${scenario.rows.join(", ")}]`,
			async () => {
				scenario.expect(await runScenario(scenario));
			},
			PARENT_TIMEOUT_MS,
		);
	}
});
