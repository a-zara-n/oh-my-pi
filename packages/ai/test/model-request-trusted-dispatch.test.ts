import { describe, expect, test } from "bun:test";
import * as path from "node:path";

// Selection only. Every child uses the actual native bootstrap and obtains its
// binding from the owned SQLite factory + fixed verifier, then composes a real
// File principal. This marker is never passed to an authority API as proof.
const nativePreloaded =
	Object.getOwnPropertyDescriptor(globalThis, Symbol.for("omp.audit.sqlite.required.v1"))?.value === true;

type Scenario =
	| "no-gate"
	| "pass"
	| "deny"
	| "abort-gate"
	| "begin-abort"
	| "begin-revoke"
	| "custom-sender"
	| "fake-supplied"
	| "forged-authorize"
	| "leaf-replay"
	| "same-stack-release"
	| "dispatch-before-revoke"
	| "gate-await-revoke"
	| "begin-epoch-change"
	| "begin-database-close"
	| "prepare-await-revoke"
	| "authorize-accessor"
	| "marked-before-required"
	| "forged-transport-stamp"
	| "internal-current-accessor";

async function probe(scenario: Scenario): Promise<Record<string, unknown>> {
	const fixture = path.join(import.meta.dir, "fixtures/model-request-trusted-dispatch-process.ts");
	const bootstrap = path.resolve(import.meta.dir, "../../../scripts/audit-library-bootstrap.ts");
	const child = Bun.spawn([process.execPath, "--preload", bootstrap, fixture, scenario], {
		stdout: "pipe",
		stderr: "pipe",
		timeout: 25_000,
	});
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(exitCode).toBe(0);
		const value: unknown = JSON.parse(stdout);
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			throw new Error("trusted dispatch fixture did not return a JSON object");
		}
		if (!("scenario" in value) || value.scenario !== scenario) throw new Error("fixture scenario mismatch");
		if (!("journalStateBefore" in value) || value.journalStateBefore !== "required-ready") {
			throw new Error("fixture did not exercise a genuine required-ready principal");
		}
		// Shape is external-process data. Narrow it without asserting a fixture DTO.
		const result: Record<string, unknown> = {};
		for (const [key, field] of Object.entries(value)) result[key] = field;
		return result;
	} finally {
		child.kill();
	}
}

describe("D37 canonical required-ready builtin dispatch (native authority)", () => {
	for (const scenario of ["no-gate", "pass"] as const) {
		test.skipIf(!nativePreloaded)(
			`${scenario}: genuine File principal reaches the actual builtin loopback`,
			async () => {
				expect(await probe(scenario)).toMatchObject({
					rejected: false,
					body: "builtin-loopback",
					received: 1,
					gateCalls: scenario === "no-gate" ? 0 : 1,
					beginCalls: 0,
					senderCalls: 0,
					outcomes: [],
					rootReacquired: true,
					journalStateAfter: "required-ready",
				});
			},
			30_000,
		);
	}

	for (const scenario of ["deny", "abort-gate"] as const) {
		test.skipIf(!nativePreloaded)(
			`${scenario}: authorization stops before loopback I/O`,
			async () => {
				expect(await probe(scenario)).toMatchObject({
					rejected: true,
					received: 0,
				gateCalls: 1,
				beginCalls: 0,
				senderCalls: 0,
				responseHeads: 0,
				chunks: 0,
				outcomes: [],
				authorityDrainRejected: true,
				authorityDrainCausesMatch: true,
				bindingDrainRejected: true,
				rootReacquired: true,
				});
			},
			30_000,
		);
	}

	for (const scenario of ["begin-abort", "begin-revoke"] as const) {
		test.skipIf(!nativePreloaded)(
			`${scenario}: synchronous lease callback precedes final admission validation`,
			async () => {
				expect(await probe(scenario)).toMatchObject({
					rejected: true,
					received: 0,
					gateCalls: 1,
					beginCalls: 1,
					responseHeads: 0,
					chunks: 0,
					senderCalls: 0,
					authorityDrainRejected: true,
					authorityDrainCausesMatch: true,
					bindingDrainRejected: true,
					rootReacquired: true,
					outcomes: [{ type: "not-sent", aborted: scenario === "begin-abort" }],
					journalStateAfter: scenario === "begin-revoke" ? "required-revoked" : "required-ready",
				});
			},
			30_000,
		);
	}

	test.skipIf(!nativePreloaded)(
		"revocation awaited inside the real gate rejects its late allow and releases the unused lease",
		async () => {
			expect(await probe("gate-await-revoke")).toMatchObject({
				rejected: true,
				received: 0,
				gateCalls: 1,
				beginCalls: 0,
				senderCalls: 0,
				responseHeads: 0,
				chunks: 0,
				authorityDrainRejected: true,
				authorityDrainCausesMatch: true,
				bindingDrainRejected: true,
				rootReacquired: true,
				outcomes: [{ type: "not-sent", aborted: false }],
				journalStateAfter: "required-revoked",
				cleanupAuthorityErrors: [],
			});
		},
		30_000,
	);

	test.skipIf(!nativePreloaded)(
		"revocation rejects prepare without admission and retains the same failure through binding drain and root release",
		async () => {
			const result = await probe("prepare-await-revoke");
			expect(result).toMatchObject({
				preparingRejected: true,
				admissionReturned: false,
				admissionsIssued: 0,
				received: 0,
				preparingError: { name: "Error", message: "Model request journal capability is unavailable" },
				revocationSucceeded: true,
				rootReacquired: true,
				journalStateAfter: "required-revoked",
				bindingDrainRejected: true,
				finalizerRootReleased: true,
				cleanupAuthorityErrors: ["Journal principal drains failed"],
			});
			expect(result.prepareCleanup).toEqual({
				name: "AggregateError",
				message: "Journal principal drains failed",
				errors: [
					{
						name: "AggregateError",
						message: "Journal bound principal graph failed",
						errors: [
							{
								name: "Error",
								message: "Model request journal capability is unavailable",
								samePrepareRejection: true,
							},
						],
					},
				],
			});
		},
		30_000,
	);

	for (const scenario of ["begin-epoch-change", "begin-database-close"] as const) {
		test.skipIf(!nativePreloaded)(
			`${scenario}: final begin rechecks real authority, refuses dispatch and frees the unconsumed root`,
			async () => {
				const result = await probe(scenario);
				expect(result).toMatchObject({
					rejected: true,
					received: 0,
					gateCalls: 1,
					beginCalls: 1,
					senderCalls: 0,
					responseHeads: 0,
					chunks: 0,
					outcomes: [{ type: "not-sent", aborted: false }],
					verifiedReacquireRejected: true,
					rootReacquired: true,
					authorityMutation: scenario === "begin-epoch-change" ? "epoch" : "writer-close",
				});
				// Deliberately invalid authority cannot produce a successful authenticated
				// close. Surface those errors instead of disguising them as clean shutdown.
				if (!Array.isArray(result.cleanupAuthorityErrors))
					throw new Error("missing invalid-authority cleanup evidence");
				const cleanupErrors: readonly unknown[] = result.cleanupAuthorityErrors;
				expect(cleanupErrors.length).toBeGreaterThan(0);
				for (const error of cleanupErrors) {
					expect(typeof error).toBe("string");
					if (typeof error !== "string") throw new Error("invalid cleanup error evidence");
					expect(error.length).toBeGreaterThan(0);
				}
			},
			30_000,
		);
	}

	test.skipIf(!nativePreloaded)(
		"queued custom async sender is rejected before its callback runs",
		async () => {
			expect(await probe("custom-sender")).toMatchObject({
				rejected: true,
				received: 0,
				gateCalls: 0,
				beginCalls: 0,
				senderCalls: 0,
				outcomes: [],
				rootReacquired: true,
			});
		},
		30_000,
	);

	test.skipIf(!nativePreloaded)(
		"supplied fake permit/admission and ended real leaf evidence cannot bypass the actual denying gate",
		async () => {
			expect(await probe("fake-supplied")).toMatchObject({
				rejected: true,
				received: 0,
				gateCalls: 1,
				fakeLeaseCalls: 0,
				beginCalls: 0,
				senderCalls: 0,
				outcomes: [],
				authorityDrainRejected: true,
				authorityDrainCausesMatch: true,
				bindingDrainRejected: true,
				rootReacquired: true,
			});
		},
		30_000,
	);

	test.skipIf(!nativePreloaded)(
		"replacing authorize cannot register a caller-issued permit in the canonical private map",
		async () => {
			expect(await probe("forged-authorize")).toMatchObject({
				rejected: true,
				received: 0,
				forgedAuthorizeCalls: 0,
				gateCalls: 0,
				beginCalls: 0,
				senderCalls: 0,
				outcomes: [],
				authorityDrainRejected: true,
				authorityDrainCausesMatch: true,
				bindingDrainRejected: true,
				rootReacquired: true,
			});
		},
		30_000,
	);

	test.skipIf(!nativePreloaded)(
		"an authorizer accessor cannot substitute a restoring fake between reference check and direct authorization",
		async () => {
			expect(await probe("authorize-accessor")).toMatchObject({
				rejected: true,
				received: 0,
				forgedAuthorizeCalls: 0,
				gateCalls: 1,
				beginCalls: 0,
				senderCalls: 0,
				outcomes: [],
				authorityDrainRejected: true,
				authorityDrainCausesMatch: true,
				bindingDrainRejected: true,
				rootReacquired: true,
			});
		},
		30_000,
	);

	test.skipIf(!nativePreloaded)(
		"publicly marking the builtin while untracked cannot skip a later required denying gate",
		async () => {
			expect(await probe("marked-before-required")).toMatchObject({
				rejected: true,
				received: 0,
				gateCalls: 1,
				beginCalls: 0,
				senderCalls: 0,
				auxiliaryTwinCalls: 0,
				outcomes: [],
				authorityDrainRejected: true,
				authorityDrainCausesMatch: true,
				bindingDrainRejected: true,
				rootReacquired: true,
			});
		},
		30_000,
	);

	test.skipIf(!nativePreloaded)(
		"copying genuine transport symbols onto a supplied sender cannot bypass the real provider's transport boundary",
		async () => {
			expect(await probe("forged-transport-stamp")).toMatchObject({
				rejected: true,
				received: 0,
				gateCalls: 0,
				beginCalls: 0,
				senderCalls: 0,
				outcomes: [],
				rootReacquired: true,
			});
		},
		30_000,
	);

	test.skipIf(!nativePreloaded)(
		"internal authorization and gate scope use the actual ALS execution, not an alternating currentExecution accessor",
		async () => {
			expect(await probe("internal-current-accessor")).toMatchObject({
				rejected: true,
				received: 0,
				gateCalls: 1,
				forgedExecutionCalls: 0,
				gatePurposes: ["main"],
				alternateJournalState: "required-ready",
				senderCalls: 0,
				outcomes: [],
				authorityDrainRejected: true,
				authorityDrainCausesMatch: true,
				bindingDrainRejected: true,
				rootReacquired: true,
			});
		},
		30_000,
	);

	test.skipIf(!nativePreloaded)(
		"leaf admissions reject replay, another genuine execution, copied attempt identity and forged admission, releasing roots",
		async () => {
			expect(await probe("leaf-replay")).toMatchObject({
				begun: true,
				replayRejected: true,
				endedPrepareRejected: true,
				executionMismatchRejected: true,
				attemptMismatchRejected: true,
				fakeAdmissionRejected: true,
				rootReacquired: true,
			});
		},
		30_000,
	);

	test.skipIf(!nativePreloaded)(
		"real short root releases in the builtin invocation stack, before the held response Promise settles",
		async () => {
			const result = await probe("same-stack-release");
			expect(result).toMatchObject({
				rejected: false,
				body: "builtin-loopback",
				received: 1,
				gateCalls: 1,
				beginCalls: 1,
				probe: { acquired: true, responsePending: true },
				inflight: { received: 1, unsettled: true, responsePending: true, journalState: "required-ready" },
				outcomes: [{ type: "response-ended", status: 200 }],
				rootReacquired: true,
			});
			// The microtask probe is queued inside lease.beginSend, before canonical
			// end. It calls the real retained-root API and releases its actual scope;
			// no callback counter/no-op probe can satisfy this assertion.
			expect(result.responseHeads).toBe(1);
			expect(typeof result.chunks).toBe("number");
			if (typeof result.chunks !== "number") throw new Error("missing observed response chunks");
			expect(result.chunks).toBeGreaterThan(0);
		},
		30_000,
	);

	test.skipIf(!nativePreloaded)(
		"dispatch before revoke stays inflight and settles sent-maybe, never not-sent",
		async () => {
			const result = await probe("dispatch-before-revoke");
			expect(result).toMatchObject({
				rejected: true,
				received: 1,
				gateCalls: 1,
				beginCalls: 1,
				inflight: { received: 1, unsettled: true, responsePending: true, journalState: "required-revoked" },
				outcomes: [{ type: "request-failed", sent: "maybe", aborted: true, transportClosed: true }],
				responseHeads: 0,
				chunks: 0,
				authorityDrainRejected: true,
				authorityDrainCausesMatch: true,
				bindingDrainRejected: true,
				rootReacquired: true,
				journalStateAfter: "required-revoked",
			});
			// This asserts arrival/settlement semantics, not first-packet OS-start timing.
		},
		30_000,
	);
});
