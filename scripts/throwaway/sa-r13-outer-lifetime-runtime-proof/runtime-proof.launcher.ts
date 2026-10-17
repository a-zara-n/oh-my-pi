/**
 * Parent entry: preflight, then one isolated worker subprocess per case (fresh gate latch).
 */
import { mkdtempSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildAllowlistedSpawnEnv, buildIsolatedPaths } from "./env.ts";
import { describeError } from "./errors.ts";
import { childEntry, integrationRoot, securityAuditRoot } from "./paths.ts";
import { assertRunnablePreflight, runPreflight } from "./preflight.ts";
import { drainProcess, parseWorkerStdout, spawnWithBootstrap } from "./process.ts";

const WORKER_TIMEOUT_MS = 180_000;

const CASE_ORDER = ["ac-ol-01", "ac-ol-08", "control-await"] as const;

interface CaseResult {
	readonly id: string;
	readonly ok: boolean;
	readonly assertions: Record<string, unknown>;
	readonly error?: Record<string, unknown>;
}

interface WorkerProcessDiagnostics {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut?: boolean;
	readonly parseError?: Record<string, unknown>;
}

interface WorkerPayload {
	readonly case: CaseResult;
	readonly publicPins?: Record<string, unknown>;
	readonly retainedNamespaces?: readonly string[];
	readonly workerProcess?: WorkerProcessDiagnostics;
}

async function runCaseWorker(
	namespaceRoot: string,
	caseId: string,
): Promise<WorkerPayload> {
	const isolated = buildIsolatedPaths(namespaceRoot);
	const allowlistedEnv = buildAllowlistedSpawnEnv({
		isolated,
		integrationRoot: integrationRoot(),
		securityAuditRoot: securityAuditRoot(),
	});
	allowlistedEnv.OMP_SMOKE_CASE = caseId;
	const workerEntry = childEntry("runtime-proof.worker.ts");
	const child = spawnWithBootstrap(workerEntry, [], allowlistedEnv);
	const drained = await drainProcess(child, WORKER_TIMEOUT_MS);
	const workerProcess: WorkerProcessDiagnostics = {
		exitCode: drained.exitCode,
		stdout: drained.stdout,
		stderr: drained.stderr,
		...(drained.timedOut ? { timedOut: true } : {}),
	};
	if (drained.timedOut) {
		return {
			case: {
				id: caseId,
				ok: false,
				assertions: { workerProcess },
				error: describeError(new Error("case worker timed out")),
			},
			workerProcess,
		};
	}
	if (drained.stdout.trim().length === 0) {
		return {
			case: {
				id: caseId,
				ok: false,
				assertions: { workerProcess },
				error: describeError(new Error(`case worker exit ${drained.exitCode} with empty stdout: ${drained.stderr}`)),
			},
			workerProcess,
		};
	}
	try {
		const line = parseWorkerStdout(drained.stdout);
		const caseField = line.case;
		const caseResult: CaseResult =
			caseField !== null &&
			typeof caseField === "object" &&
			!Array.isArray(caseField) &&
			typeof caseField.id === "string"
				? {
						id: caseField.id,
						ok: caseField.ok === true,
						assertions: {
							...(caseField.assertions !== null &&
							typeof caseField.assertions === "object" &&
							!Array.isArray(caseField.assertions)
								? caseField.assertions
								: {}),
							workerProcess,
						},
						...(caseField.error !== undefined && typeof caseField.error === "object"
							? { error: caseField.error as Record<string, unknown> }
							: {}),
					}
				: {
						id: caseId,
						ok: false,
						assertions: { workerProcess },
						error: describeError(new Error("worker JSON missing case")),
					};
		const publicPins =
			line.publicPins !== null && typeof line.publicPins === "object" && !Array.isArray(line.publicPins)
				? line.publicPins
				: undefined;
		const retainedNamespaces = Array.isArray(line.retainedNamespaces)
			? line.retainedNamespaces.filter((n): n is string => typeof n === "string")
			: undefined;
		return { case: caseResult, publicPins, retainedNamespaces, workerProcess };
	} catch (error) {
		return {
			case: {
				id: caseId,
				ok: false,
				assertions: {
					workerProcess: { ...workerProcess, parseError: describeError(error) },
				},
				error: describeError(error),
			},
			workerProcess: { ...workerProcess, parseError: describeError(error) },
		};
	}
}

async function main(): Promise<void> {
	const preflight = runPreflight();
	let preflightError: Record<string, unknown> | undefined;
	try {
		assertRunnablePreflight(preflight);
	} catch (error) {
		preflightError = describeError(error);
	}

	const namespaceRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sa-r13-outer-lifetime-")));
	const retainedNamespaces: string[] = [namespaceRoot];
	const cases: CaseResult[] = [];
	let publicPins: Record<string, unknown> | undefined;

	if (preflightError === undefined) {
		for (const caseId of CASE_ORDER) {
			const payload = await runCaseWorker(namespaceRoot, caseId);
			cases.push(payload.case);
			if (publicPins === undefined && payload.publicPins !== undefined) publicPins = payload.publicPins;
			if (payload.retainedNamespaces !== undefined) retainedNamespaces.push(...payload.retainedNamespaces);
		}
	}

	const report = {
		schemaVersion: 1,
		integrationRoot: integrationRoot(),
		preflight,
		publicPins,
		retainedNamespaces: [...new Set(retainedNamespaces)],
		cases,
		ok: preflightError === undefined && cases.every(c => c.ok),
	};

	const output: Record<string, unknown> = { ...report };
	if (preflightError !== undefined) output.preflightError = preflightError;

	process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
	if (!report.ok) process.exitCode = 1;
}

await main();
