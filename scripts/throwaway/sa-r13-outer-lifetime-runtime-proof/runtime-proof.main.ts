// Smoke observes Store.withModelRequestJournalBinding + createAgentSession and OS leases only.
// No beginJournalBindingWork/endJournalWork (no substitute handle registration).
import { mkdirSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { registerModelRequestGate } from "@oh-my-pi/pi-ai/model-request-gate";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import type { LoopbackProvider } from "../../../packages/ai/test/helpers/model-request-loopback";
import {
	openAICompletionsTextReply,
	startLoopbackProvider,
} from "../../../packages/ai/test/helpers/model-request-loopback";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../../../packages/coding-agent/test/helpers/agent-session-setup";
import type { AllowlistedEnvKey } from "./env.ts";
import { buildAllowlistedSpawnEnv, buildIsolatedPaths } from "./env.ts";
import { describeError, errorChainIncludes } from "./errors.ts";
import type { PublicPinAssertion } from "./install-public-pins.ts";
import { assertAuthorityCompositionRuntimeIdentity } from "./install-public-pins.ts";
import {
	bindingUnsettledAfterUseReturn,
	createStartupObservers,
	sdkUnsettledAfterUseReturn,
} from "./observers.ts";
import { integrationRoot, securityAuditRoot } from "./paths.ts";
import { assertRunnablePreflight, leaseProbeFromRecord, runPreflight } from "./preflight.ts";
import { parseLastJsonLine, runLeaseProbe } from "./process.ts";
import {
	assertGenuineBinding,
	AuthorityHarness,
	openAuthorityHarness,
	writerExclusiveLockPath,
} from "./store-harness.ts";

const CHILD_TIMEOUT_MS = 30_000;
const PROVIDER = "sa-r13-outer-lifetime-loopback";
const MODEL = "sa-r13-outer-lifetime-model";
const MODEL_PATTERN = `${PROVIDER}/${MODEL}`;

interface CaseResult {
	readonly id: string;
	readonly ok: boolean;
	readonly assertions: Record<string, unknown>;
	readonly error?: Record<string, unknown>;
}

interface WorkerOutput {
	readonly schemaVersion: 1;
	readonly case: CaseResult;
	readonly publicPins?: PublicPinAssertion;
	readonly retainedNamespaces: readonly string[];
}

function namespaceRootFromWorkerEnv(): string {
	const root = process.env.OMP_NAMESPACE_ROOT;
	if (root === undefined || root.length === 0) throw new Error("OMP_NAMESPACE_ROOT missing in worker allowlisted env");
	return realpathSync(root);
}

function probeAllowlistedEnv(namespaceRoot: string): Record<AllowlistedEnvKey, string> {
	const isolated = buildIsolatedPaths(namespaceRoot);
	return buildAllowlistedSpawnEnv({
		isolated,
		integrationRoot: integrationRoot(),
		securityAuditRoot: securityAuditRoot(),
	});
}

async function probeExclusive(
	lockPath: string,
	allowlistedEnv: Readonly<Record<string, string>>,
): Promise<{ acquired: boolean; child: Record<string, unknown> } | { error: Record<string, unknown> }> {
	try {
		const drained = await runLeaseProbe(lockPath, "exclusive", allowlistedEnv, CHILD_TIMEOUT_MS);
		if (drained.timedOut) return { error: describeError(new Error("lease probe timed out")) };
		if (drained.exitCode !== 0) {
			return {
				error: describeError(new Error(`lease probe exit ${drained.exitCode}: ${drained.stderr}`)),
			};
		}
		const line = parseLastJsonLine(drained.lines);
		const payload = leaseProbeFromRecord(line);
		if (!payload.ok) return { error: describeError(new Error("lease probe returned ok:false")) };
		return { acquired: payload.acquired === true, child: line };
	} catch (error) {
		return { error: describeError(error) };
	}
}

async function writeLoopbackModels(agentDir: string, origin: string): Promise<string> {
	const modelsPath = path.join(agentDir, "models.yml");
	await Bun.write(
		modelsPath,
		JSON.stringify({
			providers: {
				[PROVIDER]: {
					baseUrl: `${origin}/v1`,
					api: "openai-completions",
					apiKey: "loopback-only-unused-key",
					models: [
						{
							id: MODEL,
							name: "SA R13 outer lifetime loopback",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128_000,
							maxTokens: 4096,
						},
					],
				},
			},
		}),
	);
	return modelsPath;
}

function loopbackRegistry(agentDir: string, modelsPath: string, settings: Settings): ModelRegistry {
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime(PROVIDER, "loopback-only-unused-key");
	return new ModelRegistry(authStorage, modelsPath, {
		settings,
		cacheDbPath: path.join(agentDir, "models-cache.db"),
	});
}

function stopLoopback(server: LoopbackProvider | undefined): void {
	try {
		server?.stop();
	} catch {
		/* ignore */
	}
}

async function runAcOl01(
	harness: AuthorityHarness,
	workDir: string,
	probeEnv: Readonly<Record<string, string>>,
): Promise<CaseResult> {
	const id = "AC-OL-01-unawaited-startup";
	const assertions: Record<string, unknown> = {};
	const failures: unknown[] = [];
	const settingsReady = Promise.withResolvers<Settings>();
	const observers = createStartupObservers();
	let server: LoopbackProvider | undefined;
	let bindingJoin: Promise<{ returned: string }> | undefined;
	let sdkStartup: ReturnType<typeof createAgentSession> | undefined;
	const lockPath = await writerExclusiveLockPath(harness.store.storeId, harness.operator.writerId);
	let settingsGate: "open" | "released" = "open";

	try {
		const agentDir = path.join(workDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		setAgentDir(agentDir);
		const manager = SessionManager.create(workDir, path.join(workDir, "sessions"));
		const settings = Settings.isolated({
			extensions: [],
			"task.enableLsp": false,
			"async.enabled": false,
			"compaction.enabled": false,
			"retry.enabled": false,
			modelRoles: { default: MODEL_PATTERN, smol: MODEL_PATTERN },
		});
		server = startLoopbackProvider(() => openAICompletionsTextReply("ok"));
		const modelsPath = await writeLoopbackModels(agentDir, server.origin);
		const modelRegistry = loopbackRegistry(agentDir, modelsPath, settings);
		const model = modelRegistry.find(PROVIDER, MODEL);
		if (!model) throw new Error("loopback model missing from registry");
		registerModelRequestGate("sa-r13-runtime-proof-ac01", {
			async authorize(attempt) {
				const endpoint = attempt.wire === undefined ? undefined : new URL(attempt.wire.url);
				if (
					attempt.model.provider !== PROVIDER ||
					attempt.model.id !== MODEL ||
					endpoint?.origin !== server?.origin
				) {
					return { type: "deny", code: "fixture-non-loopback", message: "non-loopback denied" };
				}
				return { type: "pass" };
			},
		});

		bindingJoin = harness.store.withModelRequestJournalBinding(
			{ mode: "bootstrap-new", requester: harness.operator, rootSessionId: manager.getSessionId() },
			async binding => {
				observers.markUseEntered();
				assertions.journalRuntimeIdentity = await assertGenuineBinding(binding);
				sdkStartup = createAgentSession({
					cwd: workDir,
					agentDir,
					sessionManager: manager,
					modelRegistry,
					settingsManager: settingsReady.promise,
					model,
					bindProcessState: false,
					extensions: [],
					disableExtensionDiscovery: true,
					skills: [],
					rules: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
					skipPythonPreflight: true,
					modelRequestJournalLeaseBinding: binding,
				});
				observers.attachSdkStartup(sdkStartup);
				observers.markUseReturned();
				return { returned: "before-sdk-settled" };
			},
		);
		observers.attachBindingJoin(bindingJoin);

		await observers.waitForUseReturned();
		assertions.traceAfterUseReturn = { ...observers.trace };
		assertions.bindingUnsettledAfterUseReturn = bindingUnsettledAfterUseReturn(observers.trace);
		assertions.sdkUnsettledAfterUseReturn = sdkUnsettledAfterUseReturn(observers.trace);

		const duringPending = await probeExclusive(lockPath, probeEnv);
		assertions.crossProcessExclusiveDuringStartup = duringPending;
		if ("acquired" in duringPending) {
			assertions.exclusiveDeniedWhileStartupPending = duringPending.acquired === false;
		}

		settingsReady.resolve(settings);
		settingsGate = "released";
	} catch (error) {
		failures.push(error);
	} finally {
		if (settingsGate === "open") {
			try {
				settingsReady.resolve(Settings.isolated({ extensions: [] }));
			} catch {
				/* already settled */
			}
		}
		if (sdkStartup) {
			try {
				const created = await sdkStartup;
				try {
					await created.session.dispose();
					assertions.sdkOutcome = { status: "fulfilled" };
				} catch (disposeError) {
					assertions.sdkOutcome = {
						status: "fulfilled-dispose-failed",
						disposeError: describeError(disposeError),
					};
				}
			} catch (error) {
				assertions.sdkOutcome = { status: "rejected", error: describeError(error) };
			}
		}
		if (bindingJoin) {
			try {
				const value = await bindingJoin;
				assertions.bindingOutcome = { status: "fulfilled", value };
			} catch (error) {
				assertions.bindingOutcome = { status: "rejected", error: describeError(error) };
			}
		}
		const afterJoin = await probeExclusive(lockPath, probeEnv);
		assertions.crossProcessExclusiveAfterJoin = afterJoin;
		if ("acquired" in afterJoin) assertions.exclusiveAvailableAfterJoin = afterJoin.acquired === true;
		stopLoopback(server);
		try {
			closeModelCache();
		} catch (error) {
			failures.push(error);
		}
	}

	if (failures.length > 0) assertions.failures = failures.map(describeError);

	const ok =
		failures.length === 0 &&
		assertions.bindingUnsettledAfterUseReturn === true &&
		assertions.sdkUnsettledAfterUseReturn === true &&
		assertions.exclusiveDeniedWhileStartupPending === true &&
		assertions.exclusiveAvailableAfterJoin === true;

	return {
		id,
		ok,
		assertions,
		...(failures[0] !== undefined ? { error: describeError(failures[0]) } : {}),
	};
}

async function runAcOl08(
	harness: AuthorityHarness,
	workDir: string,
	probeEnv: Readonly<Record<string, string>>,
): Promise<CaseResult> {
	const id = "AC-OL-08-unawaited-reject-cleanup";
	const assertions: Record<string, unknown> = {};
	const failures: unknown[] = [];
	const settingsReady = Promise.withResolvers<Settings>();
	const settingsFailure = new Error("supported-settings-rejected-for-ac-ol-08");
	const settingsSettlement = settingsReady.promise.then(
		value => ({ kind: "fulfilled" as const, value }),
		reason => ({ kind: "rejected" as const, reason }),
	);
	const observers = createStartupObservers();
	let bindingJoin: Promise<string> | undefined;
	let sdkStartup: ReturnType<typeof createAgentSession> | undefined;
	let sdkOutcomeAfterSettingsReject: unknown;
	let bindingOutcomeAfterSettingsReject: unknown;
	let joinedPostRejectSettlements = false;
	const lockPath = await writerExclusiveLockPath(harness.store.storeId, harness.operator.writerId);
	let settingsGate: "open" | "released" = "open";

	try {
		const agentDir = path.join(workDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		setAgentDir(agentDir);
		const manager = SessionManager.create(workDir, path.join(workDir, "sessions"));

		bindingJoin = harness.store.withModelRequestJournalBinding(
			{ mode: "bootstrap-new", requester: harness.operator, rootSessionId: manager.getSessionId() },
			async binding => {
				observers.markUseEntered();
				assertions.journalRuntimeIdentity = await assertGenuineBinding(binding);
				sdkStartup = createAgentSession({
					cwd: workDir,
					agentDir,
					sessionManager: manager,
					settingsManager: settingsReady.promise,
					bindProcessState: false,
					disableExtensionDiscovery: true,
					enableMCP: false,
					enableLsp: false,
					skipPythonPreflight: true,
					modelRequestJournalLeaseBinding: binding,
				});
				observers.attachSdkStartup(sdkStartup);
				observers.markUseReturned();
				return "use-returned-unawaited";
			},
		);
		observers.attachBindingJoin(bindingJoin);

		await observers.waitForUseReturned();
		assertions.traceAfterUseReturn = { ...observers.trace };
		assertions.bindingUnsettledAfterUseReturn = bindingUnsettledAfterUseReturn(observers.trace);
		assertions.sdkUnsettledAfterUseReturn = sdkUnsettledAfterUseReturn(observers.trace);

		const during = await probeExclusive(lockPath, probeEnv);
		assertions.crossProcessExclusiveDuringPending = during;
		if ("acquired" in during) assertions.exclusiveDeniedWhilePending = during.acquired === false;

		settingsReady.reject(settingsFailure);
		settingsGate = "released";
		const postRejectSettled = await Promise.allSettled([
			settingsSettlement,
			...(sdkStartup ? [sdkStartup] : []),
			...(bindingJoin ? [bindingJoin] : []),
		]);
		joinedPostRejectSettlements = true;
		const settingsSettlementResult = postRejectSettled[0];
		if (settingsSettlementResult.status === "fulfilled") {
			const outcome = settingsSettlementResult.value;
			assertions.settingsRejectionJoined =
				outcome.kind === "rejected" && errorChainIncludes(outcome.reason, settingsFailure);
		}
		let postRejectIndex = 1;
		if (sdkStartup) {
			const sdkSettlementResult = postRejectSettled[postRejectIndex];
			postRejectIndex += 1;
			if (sdkSettlementResult?.status === "rejected") {
				sdkOutcomeAfterSettingsReject = sdkSettlementResult.reason;
			} else if (sdkSettlementResult?.status === "fulfilled") {
				sdkOutcomeAfterSettingsReject = { unexpected: "fulfilled" };
			}
		}
		if (bindingJoin) {
			const bindingSettlementResult = postRejectSettled[postRejectIndex];
			if (bindingSettlementResult?.status === "rejected") {
				bindingOutcomeAfterSettingsReject = bindingSettlementResult.reason;
			} else if (bindingSettlementResult?.status === "fulfilled") {
				bindingOutcomeAfterSettingsReject = bindingSettlementResult.value;
			}
		}
	} catch (error) {
		failures.push(error);
	} finally {
		if (settingsGate === "open") {
			try {
				settingsReady.reject(settingsFailure);
				await settingsSettlement;
			} catch {
				/* already settled */
			}
		}
		let sdkCaught: unknown = sdkOutcomeAfterSettingsReject;
		if (!joinedPostRejectSettlements && sdkStartup) {
			try {
				await sdkStartup;
				sdkCaught = { unexpected: "fulfilled" };
			} catch (error) {
				sdkCaught = error;
			}
		}
		assertions.sdkRejectedByIdentity =
			sdkCaught !== undefined && sdkCaught instanceof Error && errorChainIncludes(sdkCaught, settingsFailure);
		assertions.sdkError =
			sdkCaught === undefined
				? undefined
				: sdkCaught instanceof Error
					? describeError(sdkCaught)
					: sdkCaught;

		let bindingCaught: unknown = bindingOutcomeAfterSettingsReject;
		if (!joinedPostRejectSettlements && bindingJoin) {
			try {
				await bindingJoin;
			} catch (error) {
				bindingCaught = error;
			}
		}
		assertions.bindingRejected = bindingCaught instanceof Error;
		assertions.unrecoveredSettingsErrorPreserved =
			bindingCaught instanceof Error && errorChainIncludes(bindingCaught, settingsFailure);
		assertions.bindingError =
			bindingCaught === undefined
				? undefined
				: bindingCaught instanceof Error
					? describeError(bindingCaught)
					: bindingCaught;

		const after = await probeExclusive(lockPath, probeEnv);
		assertions.crossProcessExclusiveAfterJoin = after;
		if ("acquired" in after) assertions.exclusiveAvailableAfterJoin = after.acquired === true;

		try {
			closeModelCache();
		} catch (error) {
			failures.push(error);
		}
	}

	if (failures.length > 0) assertions.failures = failures.map(describeError);

	const ok =
		failures.length === 0 &&
		assertions.bindingUnsettledAfterUseReturn === true &&
		assertions.sdkUnsettledAfterUseReturn === true &&
		assertions.exclusiveDeniedWhilePending === true &&
		assertions.sdkRejectedByIdentity === true &&
		assertions.bindingRejected === true &&
		assertions.unrecoveredSettingsErrorPreserved === true &&
		assertions.exclusiveAvailableAfterJoin === true;

	return {
		id,
		ok,
		assertions,
		...(failures[0] !== undefined ? { error: describeError(failures[0]) } : {}),
	};
}

async function runControlAwait(
	harness: AuthorityHarness,
	workDir: string,
	probeEnv: Readonly<Record<string, string>>,
): Promise<CaseResult> {
	const id = "control-await-startup-loopback";
	const assertions: Record<string, unknown> = {};
	const failures: unknown[] = [];
	let server: LoopbackProvider | undefined;
	const lockPath = await writerExclusiveLockPath(harness.store.storeId, harness.operator.writerId);

	try {
		const agentDir = path.join(workDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		setAgentDir(agentDir);
		const manager = SessionManager.create(workDir, path.join(workDir, "sessions"));
		const settings = Settings.isolated({
			extensions: [],
			"task.enableLsp": false,
			"async.enabled": false,
			modelRoles: { default: MODEL_PATTERN, smol: MODEL_PATTERN },
		});
		server = startLoopbackProvider(() => openAICompletionsTextReply("control-ack"));
		const modelsPath = await writeLoopbackModels(agentDir, server.origin);
		const modelRegistry = loopbackRegistry(agentDir, modelsPath, settings);
		const model = modelRegistry.find(PROVIDER, MODEL);
		if (!model) throw new Error("loopback model missing");
		registerModelRequestGate("sa-r13-runtime-proof-control", {
			async authorize(attempt) {
				const endpoint = attempt.wire === undefined ? undefined : new URL(attempt.wire.url);
				if (attempt.model.provider !== PROVIDER || endpoint?.origin !== server?.origin) {
					return { type: "deny", code: "fixture-non-loopback", message: "non-loopback denied" };
				}
				return { type: "pass" };
			},
		});

		const before = await probeExclusive(lockPath, probeEnv);
		assertions.crossProcessExclusiveBefore = before;
		if ("acquired" in before) assertions.exclusiveAvailableBefore = before.acquired === true;

		let disposeError: Record<string, unknown> | undefined;
		await harness.store.withModelRequestJournalBinding(
			{ mode: "bootstrap-new", requester: harness.operator, rootSessionId: manager.getSessionId() },
			async binding => {
				assertions.journalRuntimeIdentity = await assertGenuineBinding(binding);
				const duringBinding = await probeExclusive(lockPath, probeEnv);
				assertions.crossProcessExclusiveDuringBinding = duringBinding;
				if ("acquired" in duringBinding) {
					assertions.exclusiveDeniedDuringBinding = duringBinding.acquired === false;
				}
				const created = await createAgentSession({
					cwd: workDir,
					agentDir,
					sessionManager: manager,
					modelRegistry,
					settings,
					model,
					bindProcessState: false,
					disableExtensionDiscovery: true,
					enableMCP: false,
					enableLsp: false,
					skipPythonPreflight: true,
					modelRequestJournalLeaseBinding: binding,
				});
				try {
					await created.session.dispose();
				} catch (error) {
					disposeError = describeError(error);
				}
				return "awaited-startup-complete";
			},
		);
		assertions.disposeError = disposeError ?? null;

		const after = await probeExclusive(lockPath, probeEnv);
		assertions.crossProcessExclusiveAfter = after;
		if ("acquired" in after) assertions.exclusiveAvailableAfter = after.acquired === true;
	} catch (error) {
		failures.push(error);
	} finally {
		stopLoopback(server);
		try {
			closeModelCache();
		} catch (error) {
			failures.push(error);
		}
	}

	if (failures.length > 0) assertions.failures = failures.map(describeError);

	const ok =
		failures.length === 0 &&
		assertions.exclusiveDeniedDuringBinding === true &&
		assertions.exclusiveAvailableAfter === true &&
		assertions.disposeError === null;

	return {
		id,
		ok,
		assertions,
		...(failures[0] !== undefined ? { error: describeError(failures[0]) } : {}),
	};
}

async function runIsolatedCase(
	namespaceRoot: string,
	caseId: string,
	retainedNamespaces: string[],
	run: (harness: AuthorityHarness, workDir: string, probeEnv: Readonly<Record<string, string>>) => Promise<CaseResult>,
): Promise<CaseResult> {
	const workDir = path.join(namespaceRoot, caseId);
	mkdirSync(workDir, { recursive: true });
	let harness: AuthorityHarness | undefined;
	try {
		harness = await openAuthorityHarness(path.join(workDir, "store-parent"));
		const lockPath = await writerExclusiveLockPath(harness.store.storeId, harness.operator.writerId);
		retainedNamespaces.push(path.dirname(path.dirname(lockPath)));
		return await run(harness, workDir, probeAllowlistedEnv(namespaceRoot));
	} catch (error) {
		return {
			id: caseId,
			ok: false,
			assertions: {},
			error: describeError(error),
		};
	} finally {
		try {
			harness?.close();
		} catch (error) {
			/* retain for report */
		}
	}
}

const CASE_RUNNERS: Record<
	string,
	(harness: AuthorityHarness, workDir: string, probeEnv: Readonly<Record<string, string>>) => Promise<CaseResult>
> = {
	"ac-ol-01": runAcOl01,
	"ac-ol-08": runAcOl08,
	"control-await": runControlAwait,
};

function smokeCaseIdFromEnv(): string {
	const caseId = process.env.OMP_SMOKE_CASE;
	if (caseId === undefined || caseId.length === 0) {
		throw new Error("OMP_SMOKE_CASE missing (launcher must spawn one case per worker)");
	}
	return caseId;
}

async function main(): Promise<void> {
	const caseId = smokeCaseIdFromEnv();
	const runner = CASE_RUNNERS[caseId];
	if (runner === undefined) throw new Error(`unknown OMP_SMOKE_CASE: ${caseId}`);

	assertRunnablePreflight(runPreflight());
	const publicPins = await assertAuthorityCompositionRuntimeIdentity();

	const namespaceRoot = namespaceRootFromWorkerEnv();
	const retainedNamespaces: string[] = [namespaceRoot];
	const caseResult = await runIsolatedCase(namespaceRoot, caseId, retainedNamespaces, runner);

	const output: WorkerOutput = {
		schemaVersion: 1,
		case: caseResult,
		publicPins,
		retainedNamespaces: [...new Set(retainedNamespaces)],
	};

	process.stdout.write(`${JSON.stringify(output)}\n`);
	if (!caseResult.ok) process.exitCode = 1;
}

try {
	await main();
} catch (error) {
	const caseId = process.env.OMP_SMOKE_CASE ?? "unknown";
	const fatalOutput: WorkerOutput = {
		schemaVersion: 1,
		case: { id: caseId, ok: false, assertions: {}, error: describeError(error) },
		retainedNamespaces: [],
	};
	process.stdout.write(`${JSON.stringify(fatalOutput)}\n`);
	process.exitCode = 1;
}
