/**
 * A child session created on behalf of a host session reaches the model-request gate under the HOST's root,
 * never as a free root of its own. The children here are real spawns (executor -> createAgentSession -> agent
 * loop); the model is a fake provider that asks the gate before it "sends", exactly where a transport hook does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { authorizeModelRequest, runWithModelRequestExecution } from "@oh-my-pi/pi-ai/model-request-execution";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runEvalAgent } from "@oh-my-pi/pi-coding-agent/eval/agent-bridge";
import { runEvalWait } from "@oh-my-pi/pi-coding-agent/eval/handle-bridge";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	createSessionModelRequestExecution,
	type ModelRequestRootAssignment,
} from "@oh-my-pi/pi-coding-agent/session/model-request-context";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { runStructuredSubagent } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { installFixtureGate } from "../../../ai/test/helpers/model-request-gate-fixture";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const MOCK_API_SOURCE = "test/model-request-root-handover";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
const TOP_LEVEL_ROOT = "top-level-root";
const HAND_OVER: ModelRequestRootAssignment = { kind: "child", rootSessionId: TOP_LEVEL_ROOT };
const AGENT_DEFINITION: AgentDefinition = {
	name: "worker",
	description: "test worker",
	systemPrompt: "test",
	tools: ["read"],
	model: ["mock/mock-model"],
	source: "bundled",
};

const gate = installFixtureGate();

let savedEnv: Record<string, string | undefined> = {};
let root: string;
let manager: AsyncJobManager;
const closers: Array<() => void> = [];

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

beforeEach(async () => {
	gate.reset();
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-request-root-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
	manager = new AsyncJobManager({ maxRunningJobs: 4 });
	AsyncJobManager.setInstance(manager);
});

afterEach(async () => {
	gate.reset();
	for (const close of closers.splice(0)) close();
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	AsyncJobManager.setInstance(undefined);
	await manager.dispose({ timeoutMs: 1_000 });
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	// The child sessions opened agent.db and models.db under root; Windows cannot delete open files.
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
});

function createSettings(): Settings {
	return Settings.isolated({
		"task.agentIdleTtlMs": 0,
		"task.enableLsp": false,
		"task.isolation.enabled": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		modelRoles: { default: "mock/mock-model" },
	});
}

interface SpawnEnvironment {
	cwd: string;
	artifactsDir: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
}

/** Everything a spawn needs; the fake model asks the gate on every child turn, then yields right away. */
async function createSpawnEnvironment(): Promise<SpawnEnvironment> {
	// Under the isolated HOME so project discovery cannot walk into the developer's real ~/.omp.
	const cwd = path.join(root, "home", "work");
	const artifactsDir = path.join(root, "artifacts");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(artifactsDir, { recursive: true });
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	closers.push(() => authStorage.close());
	const modelRegistry = new ModelRegistry(authStorage);
	const mock = createMockModel({
		handler: async (context, options) => {
			// Only the child's own agent loop (the one carrying the yield tool) is gated here.
			if (!(context.tools ?? []).some(tool => tool.name === "yield")) return { content: ["label"] };
			await authorizeModelRequest({
				requestId: crypto.randomUUID(),
				reason: "first",
				kind: "chat",
				model: { provider: "mock", id: "mock-model", api: "mock" },
				wire: undefined,
				signal: options?.signal,
			});
			if (context.messages.at(-1)?.role === "toolResult") return { content: ["ok"] };
			return { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "done" } }] };
		},
	});
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
	return { cwd, artifactsDir, authStorage, modelRegistry };
}

function spawnChild(
	env: SpawnEnvironment,
	overrides: { id: string; parentAgentId?: string; taskDepth?: number; modelRequestRoot?: ModelRequestRootAssignment },
) {
	return runSubprocess({
		cwd: env.cwd,
		artifactsDir: env.artifactsDir,
		agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
		task: "report",
		index: 0,
		parentAgentId: "Main",
		modelOverride: "mock/mock-model",
		authStorage: env.authStorage,
		modelRegistry: env.modelRegistry,
		settings: createSettings(),
		enableLsp: false,
		enableMCP: false,
		enableIrc: false,
		...overrides,
	});
}

/** A host's tool session as the task/eval tools see it: it hands its root over, nothing else about it matters here. */
function hostToolSession(env: SpawnEnvironment): ToolSession {
	return {
		cwd: env.cwd,
		hasUI: false,
		settings: createSettings(),
		authStorage: env.authStorage,
		modelRegistry: env.modelRegistry,
		enableLsp: false,
		enableIrc: false,
		enableMCP: false,
		asyncJobManager: manager,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionAgents: () => [],
		getActiveModelString: () => "mock/mock-model",
		childModelRequestRoot: () => HAND_OVER,
	} as unknown as ToolSession;
}

function seenRoots(): Set<string | undefined> {
	return new Set(gate.attempts.map(attempt => attempt.scope?.rootSessionId));
}

describe("child sessions reach the gate under the spawning session's root", () => {
	it("a task child spawned with the parent's hand-over is metered under the parent's root, not its own session id", async () => {
		const env = await createSpawnEnvironment();

		const result = await spawnChild(env, { id: "RootedChild", modelRequestRoot: HAND_OVER });

		expect(result.exitCode).toBe(0);
		expect(seenRoots()).toEqual(new Set([TOP_LEVEL_ROOT]));
		expect(gate.attempts.every(attempt => attempt.origin === "session")).toBe(true);
		expect(gate.attempts.every(attempt => attempt.scope?.sessionId !== TOP_LEVEL_ROOT)).toBe(true);
		expect(gate.attempts.every(attempt => attempt.scope?.agent.kind === "sub")).toBe(true);
	}, 15_000);

	it("a grandchild spawned from the child keeps the original root", async () => {
		const env = await createSpawnEnvironment();
		await spawnChild(env, { id: "DepthOneChild", modelRequestRoot: HAND_OVER });
		const child = AgentRegistry.global().get("DepthOneChild")?.session;
		if (!child) throw new Error("kept-alive child has no live session");
		const firstGeneration = gate.attempts.length;

		// The child hands its own root to ITS children; it does not start a new tree.
		const result = await spawnChild(env, {
			id: "DepthTwoChild",
			parentAgentId: "DepthOneChild",
			taskDepth: 1,
			modelRequestRoot: child.childModelRequestRoot(),
		});

		expect(result.exitCode).toBe(0);
		const grandchildRoots = new Set(gate.attempts.slice(firstGeneration).map(attempt => attempt.scope?.rootSessionId));
		expect(grandchildRoots).toEqual(new Set([TOP_LEVEL_ROOT]));
	}, 30_000);

	it("a child created inside a session's context without a hand-over has no root rather than a free one", async () => {
		const env = await createSpawnEnvironment();
		const host = createSessionModelRequestExecution({
			getSessionId: () => "ambient-host-session",
			agent: { id: "Main", kind: "main", name: "main", depth: 0 },
			modelRequestRoot: undefined,
		});

		const result = await runWithModelRequestExecution(host, () => spawnChild(env, { id: "RootlessChild" }));

		expect(result.exitCode).toBe(0);
		expect(gate.attempts.every(attempt => attempt.origin === "session")).toBe(true);
		expect(seenRoots()).toEqual(new Set([undefined]));
	}, 15_000);

	it("a structured subagent spawned from a tool session is metered under that session's root", async () => {
		const env = await createSpawnEnvironment();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [AGENT_DEFINITION],
			projectAgentsDir: null,
		});

		const { result } = await runStructuredSubagent({
			session: hostToolSession(env),
			invocationKind: "task",
			assignment: "report",
			agent: "worker",
			enableLsp: false,
			enableIrc: false,
			keepAlive: false,
		});

		expect(result.exitCode).toBe(0);
		expect(seenRoots()).toEqual(new Set([TOP_LEVEL_ROOT]));
	}, 15_000);

	it("an eval agent() child is metered under the calling session's root", async () => {
		const env = await createSpawnEnvironment();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [AGENT_DEFINITION],
			projectAgentsDir: null,
		});
		const options = { session: hostToolSession(env) };

		const handle = await runEvalAgent({ prompt: "report", agent: "worker" }, options);
		const waited = await runEvalWait({ items: [{ kind: "agent", id: handle.id }] }, options);

		expect(waited.items[0]?.status).toBe("completed");
		expect(seenRoots()).toEqual(new Set([TOP_LEVEL_ROOT]));
	}, 15_000);
});
