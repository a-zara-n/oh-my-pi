import assert from "node:assert/strict";
import * as path from "node:path";
import type { Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { resolveModelRequestScope, runWithModelRequestExecution } from "@oh-my-pi/pi-ai/model-request-execution";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	childModelRequestRootOf,
	createSessionModelRequestExecution,
	type ModelRequestRootAssignment,
	resolveModelRequestRootSource,
} from "@oh-my-pi/pi-coding-agent/session/model-request-context";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { Api, AssistantMessage } from "@oh-my-pi/pi-utils/model-data";
import {
	type ModelRequestJournalLeaseBinding,
	modelRequestJournalAuthorityRuntimeIdentity,
} from "@oh-my-pi/pi-utils/model-request-journal-authority";
import {
	assertJournalExecutionIdentity,
	assertJournalExecutionReady,
	type ModelRequestExecution,
} from "@oh-my-pi/pi-utils/model-request-journal-composition";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";

// Deliberate invalid-input casts stay at the test boundary; no authority, receipt, or ready setter is installed.
const ROOT_AGENT_ID = "RootAgent";
const agent = { kind: "main", id: ROOT_AGENT_ID, name: "main", depth: 0 } as const;
const unavailable = /Model request journal capability is unavailable/;

function createExecution(candidate?: unknown): ModelRequestExecution {
	return createSessionModelRequestExecution({
		getSessionId: () => "root",
		root: resolveModelRequestRootSource(undefined, candidate as ModelRequestJournalLeaseBinding | undefined),
		agent,
	});
}

function assertPending(execution: ModelRequestExecution): void {
	assertJournalExecutionIdentity(execution);
	assert.equal(execution.journalState, "required-pending");
	assert.equal(execution.modelRequestScope, undefined);
	assert.throws(() => assertJournalExecutionReady(execution), unavailable);
	assert.throws(() => childModelRequestRootOf(execution), unavailable);
	assert.throws(() => resolveModelRequestScope(execution), unavailable);
}

function candidateFor(rootSessionId: string): unknown {
	return Object.freeze({ runtimeIdentity: modelRequestJournalAuthorityRuntimeIdentity, rootSessionId });
}

async function assertSdkRefusesCandidate(foreignRuntime: boolean): Promise<void> {
	const tempDir = TempDir.createSync("@pi-model-request-context-journal-");
	const authStorage = createInMemoryAuthStorage();
	const provider = "model-request-context-journal-probe-provider";
	const api = "model-request-context-journal-probe-api";
	const modelId = "model-request-context-journal-probe-model";
	authStorage.keys.setRuntime(provider, "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
	let publishedSession: AgentSession | undefined;
	let providerRequests = 0;
	const providerExtension: ExtensionFactory = pi => {
		pi.registerProvider(provider, {
			baseUrl: "http://127.0.0.1:1/v1",
			apiKey: "test-key",
			api,
			streamSimple: (model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) => {
				providerRequests++;
				const stream = new AssistantMessageEventStream();
				const message: AssistantMessage = {
					...createAssistantMessage("ok"),
					api: model.api,
					provider: model.provider,
					model: model.id,
				};
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
				return stream;
			},
			models: [{
				id: modelId,
				name: "Model request context journal probe",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 8192,
			}],
		});
	};
	const settings = Settings.isolated({ "compaction.enabled": false });
	settings.setModelRole("default", `${provider}/${modelId}`);
	const candidate: unknown = foreignRuntime
		? { runtimeIdentity: {}, rootSessionId: manager.getSessionId() }
		: candidateFor(manager.getSessionId());
	try {
		await assert.rejects(async () => {
			const result = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: manager,
				agentRegistry: new AgentRegistry(),
				authStorage,
				modelRegistry,
				settings,
				extensions: [providerExtension],
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				agentId: ROOT_AGENT_ID,
				modelRequestJournalLeaseBinding: candidate as ModelRequestJournalLeaseBinding,
			});
			publishedSession = result.session;
		}, foreignRuntime ? /different authority runtime/ : /Journal binding unverified/);
		assert.equal(publishedSession, undefined);
		assert.equal(providerRequests, 0);
		// Even the rejected SDK candidate leaves the process required; creating an unbound context cannot undo it.
		assertPending(createExecution());
	} finally {
		await publishedSession?.dispose();
		await manager.close();
		modelRegistry.clearSourceRegistrations("<inline-0>");
		authStorage.close();
		tempDir.removeSync();
	}
}

function assertBindingPropagation(): void {
	const before = createExecution();
	assert.equal(before.journalState, "untracked");
	const binding = candidateFor("root") as ModelRequestJournalLeaseBinding;
	const assignment: ModelRequestRootAssignment = {
		kind: "child",
		rootSessionId: "root",
		modelRequestJournalLeaseBinding: binding,
	};
	const root = resolveModelRequestRootSource(assignment);
	assert.equal(root.kind, "inherited");
	assert.equal(root.modelRequestJournalLeaseBinding, binding);
	const execution = createSessionModelRequestExecution({
		getSessionId: () => "child",
		root,
		agent: { kind: "sub", id: "Child", name: "child", depth: 1, parentId: ROOT_AGENT_ID },
	});
	assert.equal(execution.modelRequestJournalLeaseBinding, binding);
	assertPending(execution);
	const copied: unknown = { ...binding };
	assert.throws(
		() => resolveModelRequestRootSource(assignment, copied as ModelRequestJournalLeaseBinding),
		/differs from the inherited root binding/,
	);
	assert.throws(
		() => runWithModelRequestExecution(execution, () => resolveModelRequestRootSource(undefined)),
		/must explicitly retain/,
	);
	const inherited = runWithModelRequestExecution(execution, () => resolveModelRequestRootSource(assignment, binding));
	assert.equal(inherited.modelRequestJournalLeaseBinding, binding);
	assertPending(before);
	assertPending(createExecution());
}

async function assertPromiseCannotReady(resolve: boolean): Promise<void> {
	const deferred = Promise.withResolvers<unknown>();
	// A caller-owned Promise is just another candidate, not a composition completion channel.
	const execution = createExecution(deferred.promise);
	assert.equal(execution.modelRequestJournalLeaseBinding, deferred.promise);
	assertPending(execution);
	if (resolve) {
		const fakeReady = Object.freeze({
			runtimeIdentity: modelRequestJournalAuthorityRuntimeIdentity,
			rootSessionId: "root",
			journalState: "required-ready",
			modelRequestScope: { sessionId: "root", rootSessionId: "root", purpose: "main", agent },
		});
		deferred.resolve(fakeReady);
		assert.equal(await deferred.promise, fakeReady);
		assertPending(createExecution(fakeReady));
	} else {
		const failure = new Error("registry receipt unavailable");
		const rejected = assert.rejects(deferred.promise, error => error === failure);
		deferred.reject(failure);
		await rejected;
	}
	assertPending(execution);
	assertPending(createExecution());
}

function assertFakeExecutionCannotReady(): void {
	const execution = createExecution(candidateFor("root"));
	assertPending(execution);
	const fake: unknown = Object.freeze({
		...execution,
		modelRequestJournalLeaseBinding: execution.modelRequestJournalLeaseBinding,
		journalState: "required-ready",
		modelRequestScope: { sessionId: "root", rootSessionId: "root", purpose: "main", agent },
	});
	assert.throws(() => assertJournalExecutionIdentity(fake), unavailable);
	assert.throws(() => assertJournalExecutionReady(fake as ModelRequestExecution), unavailable);
	assert.throws(() => childModelRequestRootOf(fake as ModelRequestExecution), unavailable);
	assertPending(execution);
}

const scenario = process.argv[2];
switch (scenario) {
	case "foreign-runtime":
		await assertSdkRefusesCandidate(true);
		break;
	case "fake-authority":
		await assertSdkRefusesCandidate(false);
		break;
	case "binding-propagation":
		assertBindingPropagation();
		break;
	case "rejected-promise":
		await assertPromiseCannotReady(false);
		break;
	case "resolved-promise":
		await assertPromiseCannotReady(true);
		break;
	case "fake-execution":
		assertFakeExecutionCannotReady();
		break;
	default:
		throw new Error(`Unknown model request context probe: ${scenario}`);
}
console.log(`model-request-context:${scenario}:ok`);
