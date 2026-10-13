import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import {
	type Api,
	type AssistantMessage,
	type Context,
	type Model,
	type SimpleStreamOptions,
	streamSimple,
} from "@oh-my-pi/pi-ai";
import { getModelRequestExecution, resolveModelRequestScope } from "@oh-my-pi/pi-ai/model-request-execution";
import type { ModelRequestAgent, ModelRequestPurpose } from "@oh-my-pi/pi-ai/model-request-gate";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadMnemopiConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import { loadMnemopi, loadMnemopiCore, MnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { ModelRequestRootAssignment } from "@oh-my-pi/pi-coding-agent/session/model-request-context";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { assistantMsg, userMsg } from "./utilities";

const API = "model-request-context-test-api";
const PROVIDER = "model-request-context-test-provider";
const MODEL_ID = "model-request-context-test-model";
const ROOT_AGENT_ID = "RootAgent";

/**
 * What the model-request context looks like from inside a provider's own request callback, i.e. the stack a real
 * transport would run on. It is read through the public context API; no gate is involved. This layer installs no
 * per-attempt hook, so these observations show which context a request is issued under, not that a gate saw it.
 */
interface ObservedRequest {
	readonly context: "session" | "none";
	readonly sessionId?: string;
	readonly rootSessionId?: string;
	readonly purpose?: ModelRequestPurpose;
	readonly agent?: ModelRequestAgent;
}

function observeRequestContext(): ObservedRequest {
	const execution = getModelRequestExecution();
	if (execution === undefined) return { context: "none" };
	const scope = resolveModelRequestScope(execution);
	return {
		context: "session",
		sessionId: scope.sessionId,
		rootSessionId: scope.rootSessionId,
		purpose: scope.purpose,
		agent: scope.agent,
	};
}

function sessionIdOf(session: AgentSession): string {
	return session.sessionManager.getSessionId();
}

describe("model request context of an AgentSession", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];
	const observed: ObservedRequest[] = [];

	/**
	 * The provider is registered the way an SDK embedder registers one: through an inline extension. A provider added
	 * straight to the registry before the session exists would be dropped when `createAgentSession` syncs the
	 * registry with the active extensions.
	 */
	const providerExtension: ExtensionFactory = pi => {
		pi.registerProvider(PROVIDER, {
			baseUrl: "http://127.0.0.1:1/v1",
			apiKey: "test-key",
			api: API,
			streamSimple: (model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) => {
				observed.push(observeRequestContext());
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
			models: [
				{
					id: MODEL_ID,
					name: "Model request context test model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 8192,
				},
			],
		});
	};

	beforeEach(() => {
		observed.length = 0;
		tempDir = TempDir.createSync("@pi-model-request-context-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime(PROVIDER, "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) await session.dispose();
		modelRegistry.clearSourceRegistrations("<inline-0>");
		authStorage.close();
		tempDir.removeSync();
	});

	async function createSession(init: {
		agentId: string;
		taskDepth?: number;
		modelRequestRoot?: ModelRequestRootAssignment;
		settings?: Settings;
		model?: Model<Api>;
	}): Promise<AgentSession> {
		const settings = init.settings ?? Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${PROVIDER}/${MODEL_ID}`);
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			agentRegistry: new AgentRegistry(),
			authStorage,
			modelRegistry,
			settings,
			model: init.model,
			extensions: [providerExtension],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			agentId: init.agentId,
			taskDepth: init.taskDepth,
			modelRequestRoot: init.modelRequestRoot,
		});
		sessions.push(session);
		return session;
	}

	async function seedConversation(session: AgentSession): Promise<void> {
		for (const [question, answer] of [
			["first question", "first answer"],
			["second question", "second answer"],
		] as const) {
			const user = userMsg(question);
			const assistant = assistantMsg(answer);
			session.agent.appendMessage(user);
			session.sessionManager.appendMessage(user);
			session.agent.appendMessage(assistant);
			session.sessionManager.appendMessage(assistant);
		}
	}

	it("attributes a user-started session's prompt to the session as its own root", async () => {
		const session = await createSession({ agentId: ROOT_AGENT_ID });

		await session.prompt("hello");
		await session.waitForIdle();

		expect(observed[0]).toEqual({
			context: "session",
			sessionId: sessionIdOf(session),
			rootSessionId: sessionIdOf(session),
			purpose: "main",
			agent: { kind: "main", id: ROOT_AGENT_ID, name: "main", depth: 0 },
		});
		expect(
			observed.every(request => request.context === "session" && request.rootSessionId === sessionIdOf(session)),
		).toBe(true);
	});

	it("attributes a child's requests to its own session and to the root its spawner handed over", async () => {
		const parent = await createSession({ agentId: ROOT_AGENT_ID });
		const child = await createSession({
			agentId: "ChildAgent",
			taskDepth: 1,
			modelRequestRoot: parent.childModelRequestRoot(),
		});

		await child.prompt("work");
		await child.waitForIdle();

		expect(sessionIdOf(child)).not.toBe(sessionIdOf(parent));
		expect(observed[0]).toMatchObject({
			context: "session",
			sessionId: sessionIdOf(child),
			rootSessionId: sessionIdOf(parent),
			purpose: "subagent",
			agent: { kind: "sub", id: "ChildAgent", depth: 1 },
		});
	});

	it("follows the live session id of a root across /new, for its own requests and for children it spawns afterwards", async () => {
		const session = await createSession({ agentId: ROOT_AGENT_ID });
		await session.prompt("before the reset");
		await session.waitForIdle();
		const previousId = sessionIdOf(session);

		expect(await session.newSession()).toBe(true);
		const freshId = sessionIdOf(session);
		await session.prompt("after the reset");
		await session.waitForIdle();

		expect(freshId).not.toBe(previousId);
		const requests = observed.filter(request => request.purpose === "main");
		expect(requests.map(request => [request.sessionId, request.rootSessionId])).toEqual([
			[previousId, previousId],
			[freshId, freshId],
		]);
		expect(session.childModelRequestRoot()).toEqual({ kind: "child", rootSessionId: freshId });
	});

	it("gives a session created inside another session's context without a hand-over no root", async () => {
		const parent = await createSession({ agentId: ROOT_AGENT_ID });
		const orphan = await parent.runInModelRequestContext(() => createSession({ agentId: "OrphanAgent", taskDepth: 1 }));

		await orphan.prompt("work");
		await orphan.waitForIdle();

		expect(observed[0]).toMatchObject({
			context: "session",
			sessionId: sessionIdOf(orphan),
			rootSessionId: undefined,
		});
		expect(orphan.childModelRequestRoot()).toEqual({ kind: "child", rootSessionId: undefined });
	});

	it("declares the title purpose for title generation", async () => {
		const session = await createSession({ agentId: ROOT_AGENT_ID });

		await session.generateTitle("Fix the failing login redirect in the auth middleware");

		expect(observed.length).toBeGreaterThan(0);
		expect(observed).toEqual(
			observed.map(() => ({
				context: "session",
				sessionId: sessionIdOf(session),
				rootSessionId: sessionIdOf(session),
				purpose: "title",
				agent: { kind: "main", id: ROOT_AGENT_ID, name: "main", depth: 0 },
			})),
		);
	});

	it("declares the compaction purpose for the summary requests of a manual compaction", async () => {
		const session = await createSession({
			agentId: ROOT_AGENT_ID,
			settings: Settings.isolated({ "compaction.keepRecentTokens": 1, "compaction.methodOrder": ["soft"] }),
		});
		await seedConversation(session);

		await session.compact(undefined, { suppressContinuation: true });

		expect(observed.length).toBeGreaterThan(0);
		expect(new Set(observed.map(request => request.purpose))).toEqual(new Set(["compaction"]));
		expect(observed.every(request => request.rootSessionId === sessionIdOf(session))).toBe(true);
	});

	it("declares the compaction purpose for the native remote compaction request, which does not use the side stream", async () => {
		authStorage.keys.setRuntime("openai", "test-key");
		const bundled = modelRegistry
			.getAll("chat")
			.filter(candidate => candidate.provider === "openai" && candidate.api === "openai-responses")
			.sort((a, b) => a.id.localeCompare(b.id))[0];
		if (!bundled) throw new Error("Expected a bundled openai-responses model in the catalog");
		// Catalog identity and compat are kept; only the endpoint is replaced by a loopback address nothing listens on.
		const remoteModel: Model<Api> = { ...bundled, baseUrl: "http://127.0.0.1:1/v1" };
		const fetched: Array<{ url: string; sessionId: string | undefined; purpose: string | undefined }> = [];
		const fetchStub = Object.assign(
			async (input: string | URL | Request) => {
				const execution = getModelRequestExecution();
				const scope = execution === undefined ? undefined : resolveModelRequestScope(execution);
				fetched.push({
					url: String(input instanceof Request ? input.url : input),
					sessionId: scope?.sessionId,
					purpose: scope?.purpose,
				});
				return new Response(JSON.stringify({ error: { message: "stubbed" } }), {
					status: 400,
					headers: { "content-type": "application/json" },
				});
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
		const session = await createSession({
			agentId: ROOT_AGENT_ID,
			model: remoteModel,
			settings: Settings.isolated({ "compaction.keepRecentTokens": 1, "compaction.methodOrder": ["remote"] }),
		});
		await seedConversation(session);

		// A manual /compact starts with no model-request context active, like a slash-command handler.
		expect(getModelRequestExecution()).toBeUndefined();
		await expect(session.compact(undefined, { suppressContinuation: true })).rejects.toThrow();

		const remote = fetched.filter(request => request.url.startsWith("http://127.0.0.1:1/"));
		expect(remote.length).toBeGreaterThan(0);
		expect(remote.map(request => [request.sessionId, request.purpose])).toEqual(
			remote.map(() => [sessionIdOf(session), "compaction"]),
		);
	});

	it("declares the side-channel purpose for an ephemeral side turn", async () => {
		const session = await createSession({ agentId: ROOT_AGENT_ID });
		await session.prompt("hello");
		await session.waitForIdle();
		observed.length = 0;

		await session.runEphemeralTurn({ promptText: "Where are we?" });

		expect(observed).toEqual([
			{
				context: "session",
				sessionId: sessionIdOf(session),
				rootSessionId: sessionIdOf(session),
				purpose: "side-channel",
				agent: { kind: "main", id: ROOT_AGENT_ID, name: "main", depth: 0 },
			},
		]);
	});

	it("runs an advisor's requests as the advisor agent, billed to the advising session's root", async () => {
		const session = await createSession({ agentId: ROOT_AGENT_ID });
		session.settings.setModelRole("advisor", `${PROVIDER}/${MODEL_ID}`);
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected the advisor agent to be live");

		await advisor.prompt("review the change");

		expect(observed).toEqual([
			{
				context: "session",
				sessionId: sessionIdOf(session),
				rootSessionId: sessionIdOf(session),
				purpose: "advisor",
				agent: { kind: "sub", id: "advisor", name: "advisor", depth: 0, parentId: ROOT_AGENT_ID },
			},
		]);
	});

	it("declares the memory purpose for an auto-learn capture launched from the session", async () => {
		const session = await createSession({ agentId: ROOT_AGENT_ID });

		const model = session.model;
		if (!model) throw new Error("Expected the session to have a model");

		await session.runAutolearnCapture(async () => {
			await streamSimple(
				model,
				{ messages: [{ role: "user", content: "capture", timestamp: Date.now() }] },
				{ apiKey: "test-key" },
			).result();
		});

		expect(observed).toEqual([
			{
				context: "session",
				sessionId: sessionIdOf(session),
				rootSessionId: sessionIdOf(session),
				purpose: "memory",
				agent: { kind: "main", id: ROOT_AGENT_ID, name: "main", depth: 0 },
			},
		]);
	});

	it("runs a memory listener attached with no session context active (as /memory reset does) under the session", async () => {
		const session = await createSession({ agentId: ROOT_AGENT_ID });
		const hookRuns: Array<{ hook: string; sessionId: string | undefined; purpose: string | undefined }> = [];
		const observe = (hook: string): void => {
			const execution = getModelRequestExecution();
			const scope = execution === undefined ? undefined : resolveModelRequestScope(execution);
			hookRuns.push({ hook, sessionId: scope?.sessionId, purpose: scope?.purpose });
		};
		vi.spyOn(MnemopiSessionState.prototype, "maybeRecallOnAgentStart").mockImplementation(async () => observe("recall"));
		vi.spyOn(MnemopiSessionState.prototype, "maybeRetainOnAgentEnd").mockImplementation(async () => observe("retain"));
		await Promise.all([loadMnemopi(), loadMnemopiCore()]);
		const settings = Settings.isolated({
			"memory.backend": "mnemopi",
			"mnemopi.dbPath": path.join(tempDir.path(), "mnemopi.db"),
			"mnemopi.noEmbeddings": true,
			"mnemopi.llmMode": "none",
		});
		const state = new MnemopiSessionState({
			sessionId: sessionIdOf(session),
			config: loadMnemopiConfig(settings, tempDir.path()),
			session,
		});

		// The test stack has no model-request context, exactly like a slash-command handler.
		expect(getModelRequestExecution()).toBeUndefined();
		state.attachSessionListeners();
		await session.prompt("hello");
		await session.waitForIdle();
		await state.dispose({ consolidate: false });

		expect(hookRuns).toEqual([
			{ hook: "recall", sessionId: sessionIdOf(session), purpose: "memory" },
			{ hook: "retain", sessionId: sessionIdOf(session), purpose: "memory" },
		]);
	});
});
