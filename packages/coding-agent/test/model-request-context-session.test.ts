import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import {
	type Api,
	type AssistantMessage,
	type Context,
	type Model,
	type SimpleStreamOptions,
	streamSimple,
} from "@oh-my-pi/pi-ai";
import {
	authorizeModelRequest,
	getModelRequestExecution,
	resolveModelRequestScope,
} from "@oh-my-pi/pi-ai/model-request-execution";
import type { ModelRequestAttempt } from "@oh-my-pi/pi-ai/model-request-gate";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadMnemopiConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import { loadMnemopi, loadMnemopiCore, MnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { ModelRequestRootAssignment } from "@oh-my-pi/pi-coding-agent/session/model-request-context";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type FixtureGate, installFixtureGate } from "../../ai/test/helpers/model-request-gate-fixture";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { assistantMsg, userMsg } from "./utilities";

const API = "model-request-context-test-api";
const PROVIDER = "model-request-context-test-provider";
const MODEL_ID = "model-request-context-test-model";
const SOURCE_ID = "model-request-context-test";
const ROOT_AGENT_ID = "RootAgent";

/**
 * A provider whose requests go through the same per-attempt gate call a real transport makes, so what the gate
 * observes is what a provider request issued from that call site would present.
 */
function fakeProviderStream(model: Model<Api>, _context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message: AssistantMessage = {
		...createAssistantMessage("ok"),
		api: model.api,
		provider: model.provider,
		model: model.id,
	};
	void (async () => {
		try {
			await authorizeModelRequest({
				requestId: Bun.randomUUIDv7(),
				reason: "first",
				kind: "chat",
				model: { provider: model.provider, id: model.id, api: model.api },
				wire: undefined,
				signal: options?.signal,
			});
		} catch (error) {
			stream.push({
				type: "error",
				reason: "error",
				error: { ...message, stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error) },
			});
			return;
		}
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: "stop", message });
	})();
	return stream;
}

/** What a gate sees of one attempt that a consumer attributes spend or policy by. */
function seenBy(attempt: ModelRequestAttempt) {
	return {
		origin: attempt.origin,
		sessionId: attempt.scope?.sessionId,
		rootSessionId: attempt.scope?.rootSessionId,
		purpose: attempt.scope?.purpose,
		agent: attempt.scope?.agent,
	};
}

function sessionIdOf(session: AgentSession): string {
	return session.sessionManager.getSessionId();
}

describe("model request context of an AgentSession", () => {
	let gate: FixtureGate;
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model<Api>;
	const sessions: AgentSession[] = [];

	beforeAll(() => {
		gate = installFixtureGate();
	});

	beforeEach(() => {
		gate.reset();
		tempDir = TempDir.createSync("@pi-model-request-context-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime(PROVIDER, "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		modelRegistry.registerProvider(
			PROVIDER,
			{
				baseUrl: "http://127.0.0.1:1/v1",
				apiKey: "test-key",
				api: API,
				streamSimple: fakeProviderStream,
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
			},
			SOURCE_ID,
		);
		const registered = modelRegistry.find(PROVIDER, MODEL_ID);
		if (!registered) throw new Error("Expected the fake provider model to be registered");
		model = registered;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) await session.dispose();
		modelRegistry.clearSourceRegistrations(SOURCE_ID);
		authStorage.close();
		tempDir.removeSync();
		gate.reset();
	});

	async function createSession(init: {
		agentId: string;
		taskDepth?: number;
		modelRequestRoot?: ModelRequestRootAssignment;
		settings?: Settings;
	}): Promise<AgentSession> {
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			agentRegistry: new AgentRegistry(),
			authStorage,
			modelRegistry,
			settings: init.settings ?? Settings.isolated({ "compaction.enabled": false }),
			model,
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

		const attempts = gate.attempts.map(seenBy);
		expect(attempts[0]).toEqual({
			origin: "session",
			sessionId: sessionIdOf(session),
			rootSessionId: sessionIdOf(session),
			purpose: "main",
			agent: { kind: "main", id: ROOT_AGENT_ID, name: "main", depth: 0 },
		});
		expect(attempts.every(attempt => attempt.origin === "session" && attempt.rootSessionId === sessionIdOf(session))).toBe(
			true,
		);
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
		expect(seenBy(gate.attempts[0]!)).toMatchObject({
			origin: "session",
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
		const requests = gate.attempts.filter(attempt => attempt.scope?.purpose === "main").map(seenBy);
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

		expect(seenBy(gate.attempts[0]!)).toMatchObject({
			origin: "session",
			sessionId: sessionIdOf(orphan),
			rootSessionId: undefined,
		});
		expect(orphan.childModelRequestRoot()).toEqual({ kind: "child", rootSessionId: undefined });
	});

	it("declares the title purpose for title generation", async () => {
		const session = await createSession({ agentId: ROOT_AGENT_ID });

		await session.generateTitle("Fix the failing login redirect in the auth middleware");

		expect(gate.attempts.length).toBeGreaterThan(0);
		expect(gate.attempts.map(seenBy)).toEqual(
			gate.attempts.map(() => ({
				origin: "session",
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

		expect(gate.attempts.length).toBeGreaterThan(0);
		expect(new Set(gate.attempts.map(attempt => attempt.scope?.purpose))).toEqual(new Set(["compaction"]));
		expect(gate.attempts.every(attempt => attempt.scope?.rootSessionId === sessionIdOf(session))).toBe(true);
	});

	it("declares the side-channel purpose for an ephemeral side turn", async () => {
		const session = await createSession({ agentId: ROOT_AGENT_ID });
		await session.prompt("hello");
		await session.waitForIdle();
		gate.reset();

		await session.runEphemeralTurn({ promptText: "Where are we?" });

		expect(gate.attempts.map(seenBy)).toEqual([
			{
				origin: "session",
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

		expect(gate.attempts.map(seenBy)).toEqual([
			{
				origin: "session",
				sessionId: sessionIdOf(session),
				rootSessionId: sessionIdOf(session),
				purpose: "advisor",
				agent: { kind: "sub", id: "advisor", name: "advisor", depth: 0, parentId: ROOT_AGENT_ID },
			},
		]);
	});

	it("declares the memory purpose for an auto-learn capture launched from the session", async () => {
		const session = await createSession({ agentId: ROOT_AGENT_ID });

		await session.runAutolearnCapture(async () => {
			await streamSimple(
				model,
				{ messages: [{ role: "user", content: "capture", timestamp: Date.now() }] },
				{ apiKey: "test-key" },
			).result();
		});

		expect(gate.attempts.map(seenBy)).toEqual([
			{
				origin: "session",
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
