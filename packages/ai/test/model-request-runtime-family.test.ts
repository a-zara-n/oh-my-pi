import { describe, expect, test } from "bun:test";
import * as path from "node:path";

// Test selection only. Native children obtain real owned SQLite/credential/
// binding/File principals; no marker or fixture DTO is passed as authority.
const nativePreloaded = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("omp.audit.sqlite.required.v1"))?.value === true;

async function probe(mode: "native" | "untracked"): Promise<Record<string, unknown>> {
	const fixture = path.join(import.meta.dir, "fixtures/model-request-runtime-family-process.ts");
	const bootstrap = path.resolve(import.meta.dir, "../../../scripts/audit-library-bootstrap.ts");
	const child = Bun.spawn([process.execPath, ...(mode === "native" ? ["--preload", bootstrap] : []), fixture, mode], {
		stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000,
	});
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
		]);
		if (exitCode !== 0) throw new Error(`runtime family ${mode} fixture exited ${exitCode}:\n${stdout}\n${stderr}`);
		const value: unknown = JSON.parse(stdout);
		if (value === null || typeof value !== "object" || Array.isArray(value) || !("mode" in value) || value.mode !== mode) {
			throw new Error("runtime family fixture did not return the requested result");
		}
		const result: Record<string, unknown> = {};
		for (const [key, field] of Object.entries(value)) result[key] = field;
		return result;
	} finally {
		if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
	}
}

describe("R12-A runtime exact parent family", () => {
	test("ordinary untracked root/child/deep/derive/revive and parent-optional callers need no File principal", async () => {
		expect(await probe("untracked")).toMatchObject({
			states: ["untracked", "untracked", "untracked", "untracked", "untracked", "untracked"],
			derivedDifferentObject: true,
			scopes: [
				{ rootSessionId: "ordinary-root", sessionId: "ordinary-root", purpose: "main" },
				{ rootSessionId: "ordinary-root", sessionId: "ordinary-child", purpose: "subagent" },
				{ rootSessionId: "ordinary-root", sessionId: "ordinary-child", purpose: "advisor" },
				{ rootSessionId: "ordinary-root", sessionId: "ordinary-deep", purpose: "subagent" },
				{ rootSessionId: "ordinary-root", sessionId: "ordinary-revived", purpose: "subagent" },
				{ rootSessionId: "ordinary-root", sessionId: "ordinary-legacy", purpose: "subagent" },
			],
		});
	}, 35_000);

	test.skipIf(!nativePreloaded)("genuine derived parents compose real child/deep principals, but same-root/DTO different families are rejected", async () => {
		expect(await probe("native")).toMatchObject({
			pendingSingleArgument: true,
			parentGetterCalls: 1,
			derivedDifferentObject: true,
			readyStates: ["required-ready", "required-ready", "required-ready", "required-ready", "required-ready", "required-ready"],
			sameRoot: true, sameAgentDto: true, sameBinding: true,
			wrongFamilyRejected: true, pureDifferentFamilyRejected: true,
			fakeFirstRejected: true, fakeSecondRejected: true,
			missingParentRejected: true, wrongRootRejected: true, wrongBindingRejected: true,
			deepParentMatches: true, handoverWithoutAlsReady: true,
			revokedIdentityPure: true, revokedReadyRejected: true, revokedParentRejected: true,
		});
	}, 35_000);
});
