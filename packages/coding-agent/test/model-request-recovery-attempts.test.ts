/**
 * A turn the session re-issues after a failure is told to the model-request gate as a re-attempt of the request it
 * follows: a retry of the same model is a `turn-retry`, a switch to a fallback model a `model-fallback`, and each names
 * the failed attempt as `retryOf`. The first request of a turn, and every request of a later turn, is a plain `first`.
 * The provider is a loopback server reached through the real transport; the gate is the shared fixture.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { installFixtureGate } from "../../ai/test/helpers/model-request-gate-fixture";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const gate = installFixtureGate();

const PROVIDER = "loopback-turn";
const PRIMARY_ID = "turn-primary";
const FALLBACK_ID = "turn-fallback";

let server: Bun.Server<undefined>;
let respond: (modelId: string | undefined, index: number) => Response;
const seenModels: Array<string | undefined> = [];

/** A proxy admission rejection: the transport surfaces it at once, so it is the turn that has to retry. */
function admissionRejected(): Response {
	const error = { message: "admission rejected", rate_limit_type: "max_parallel_requests" };
	return new Response(JSON.stringify({ error }), { status: 429, headers: { "content-type": "application/json" } });
}

function answered(text: string): Response {
	const frames = [
		{ type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{
			type: "response.content_part.added",
			item_id: "msg_1",
			output_index: 0,
			content_index: 0,
			part: { type: "output_text", text: "", annotations: [] },
		},
		{ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: text },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text, annotations: [] }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp_1",
				status: "completed",
				output: [],
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			},
		},
	];
	return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("AgentSession turn recovery and the model-request gate", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(() => {
		gate.reset();
		seenModels.length = 0;
		respond = () => answered("ok");
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const body = (await request.json()) as { model?: string };
				seenModels.push(body.model);
				return respond(body.model, seenModels.length - 1);
			},
		});
		tempDir = TempDir.createSync("@pi-recovery-attempts-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime(PROVIDER, "loopback-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		modelRegistry.clearSourceRegistrations("<inline-0>");
		authStorage.close();
		tempDir.removeSync();
		await server.stop(true);
		gate.reset();
	});

	async function startSession(settings: Settings): Promise<AgentSession> {
		// Registered the way an SDK embedder registers a provider; the real openai-completions transport talks to it.
		const providerExtension: ExtensionFactory = pi => {
			pi.registerProvider(PROVIDER, {
				baseUrl: `http://127.0.0.1:${server.port}/v1`,
				apiKey: "loopback-key",
				api: "openai-responses",
				models: [PRIMARY_ID, FALLBACK_ID].map(id => ({
					id,
					name: id,
					reasoning: false,
					input: ["text" as const],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 4096,
				})),
			});
		};
		settings.setModelRole("default", `${PROVIDER}/${PRIMARY_ID}`);
		const created = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
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
		});
		session = created.session;
		return created.session;
	}

	async function promptAndWait(target: AgentSession, text: string): Promise<AgentSessionEvent[]> {
		const events: AgentSessionEvent[] = [];
		const unsubscribe = target.subscribe(event => events.push(event));
		await target.prompt(text);
		await target.waitForIdle();
		unsubscribe();
		return events;
	}

	it("tells the gate the automatic retry of a failed turn is a turn-retry of the failed attempt", async () => {
		respond = (_model, index) => (index === 0 ? admissionRejected() : answered("recovered"));
		const target = await startSession(
			Settings.isolated({ "compaction.enabled": false, "retry.baseDelayMs": 1, "retry.maxRetries": 2 }),
		);

		const events = await promptAndWait(target, "hello");

		expect(events.some(event => event.type === "auto_retry_start")).toBe(true);
		expect(seenModels).toEqual([PRIMARY_ID, PRIMARY_ID]);
		const [first, retry] = gate.attempts;
		expect(gate.attempts.map(attempt => attempt.reason)).toEqual(["first", "turn-retry"]);
		expect(first.retryOf).toBeUndefined();
		expect(retry.retryOf).toBe(first.attemptId);
		expect(retry.model.id).toBe(PRIMARY_ID);

		// The next prompt is a new turn: it neither continues the retry chain nor inherits its reason.
		await promptAndWait(target, "and again");
		const next = gate.attempts[2];
		expect(next.reason).toBe("first");
		expect(next.retryOf).toBeUndefined();
	});

	it("tells the gate the request to the fallback model is a model-fallback of the failed attempt", async () => {
		respond = model => (model === PRIMARY_ID ? admissionRejected() : answered("from fallback"));
		const target = await startSession(
			Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 1,
				"retry.maxRetries": 0,
				"retry.fallbackChains": { default: [`${PROVIDER}/${FALLBACK_ID}`] },
			}),
		);

		const events = await promptAndWait(target, "hello");

		expect(events.some(event => event.type === "retry_fallback_applied")).toBe(true);
		expect(seenModels).toEqual([PRIMARY_ID, FALLBACK_ID]);
		const [first, fallback] = gate.attempts;
		expect(gate.attempts.map(attempt => attempt.reason)).toEqual(["first", "model-fallback"]);
		expect(fallback.model.id).toBe(FALLBACK_ID);
		expect(fallback.retryOf).toBe(first.attemptId);
	});

	it("does not retry a turn whose request the gate denied", async () => {
		gate.setHandler(() => ({ type: "deny", code: "refused", message: "429 rate limit, retry" }));
		const target = await startSession(
			Settings.isolated({ "compaction.enabled": false, "retry.baseDelayMs": 1, "retry.maxRetries": 2 }),
		);

		const events = await promptAndWait(target, "hello");

		expect(events.some(event => event.type === "auto_retry_start")).toBe(false);
		expect(seenModels).toHaveLength(0);
		expect(gate.attempts).toHaveLength(1);
	});
});
