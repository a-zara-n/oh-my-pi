// Native selection must precede the SDK application graph, as in the existing journal fixtures.
import "../../../../scripts/audit-library-bootstrap";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { getModelRequestExecution, resolveModelRequestScope } from "@oh-my-pi/pi-ai/model-request-execution";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { resolveModelRequestRootSource } from "@oh-my-pi/pi-coding-agent/session/model-request-context";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { isRecord, setAgentDir } from "@oh-my-pi/pi-utils";
import { assertJournalExecutionIdentity, assertJournalExecutionReady } from "@oh-my-pi/pi-utils/model-request-journal-composition";
import { openAICompletionsTextReply, sseReply, startLoopbackProvider } from "../../../ai/test/helpers/model-request-loopback";
import { R11JournalFixture } from "../../../utils/test/fixtures/model-request-journal-r11";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const A = "WarmSiblingA";
const B = "WarmSiblingB";
const WAKE = "warm-parent-regression-wake";
const unavailable = /Model request journal capability is unavailable/;
const fixture = new R11JournalFixture();
const directory = fixture.directory;
setAgentDir(path.join(directory, "agent"));
const manager = SessionManager.create(directory, path.join(directory, "sessions"));
const rootFile = manager.getSessionFile();
assert(rootFile !== undefined);
const rootCell = fixture.open(rootFile);
const authStorage = createInMemoryAuthStorage();
authStorage.keys.setRuntime("openai", "loopback-only-unused-key");
let stage = "native-authority";
let rootSession: AgentSession | undefined;
let writeStartedUnderB = false;
let writeFailed: boolean | undefined;
let writeResult: unknown;
let wakeDispatched = false;
const server = startLoopbackProvider(request => {
	const body: unknown = JSON.parse(new TextDecoder().decode(request.body));
	assert(isRecord(body));
	const tools = Array.isArray(body.tools) ? body.tools : [];
	const hasYield = tools.some(tool => isRecord(tool) && isRecord(tool.function) && tool.function.name === "yield");
	if (!hasYield) return openAICompletionsTextReply("local fixture label");
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const wakeRequested = messages.some(message => isRecord(message) && message.role === "user" &&
		JSON.stringify(message.content).includes(WAKE));
	const writing = wakeRequested && !wakeDispatched;
	if (writing) wakeDispatched = true;
	const name = writing ? "write" : "yield";
	const args = writing ? { path: `agent://${A}`, content: "wake from genuine sibling B" } : { type: "result", data: "done" };
	const chunk = { id: "chatcmpl-warm-parent", object: "chat.completion.chunk", created: 0, model: "gpt-4o-mini" };
	return sseReply([
		{ ...chunk, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${name}_${server.requests.length}`,
			type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] },
		{ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
		"[DONE]",
	]);
});
const modelsPath = path.join(directory, "models.yml");
fs.writeFileSync(modelsPath, JSON.stringify({ providers: { openai: {
	baseUrl: `${server.origin}/v1`, api: "openai-completions", apiKey: "loopback-only-unused-key",
} } }));
const settings = Settings.isolated({
	"task.agentIdleTtlMs": 0, "task.enableLsp": false, "task.isolation.enabled": false,
	"async.enabled": false, "compaction.enabled": false, "retry.enabled": false,
	"todo.enabled": false, "todo.reminders": false, "advisor.enabled": false,
	modelRoles: { default: "openai/gpt-4o-mini" },
});
const modelRegistry = new ModelRegistry(authStorage, modelsPath, { settings,
	cacheDbPath: path.join(directory, "models-cache.db") });

async function waitForIdle(session: AgentSession): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (session.isStreaming) {
		assert(Date.now() < deadline, "actual revived wake did not finish");
		await Bun.sleep(10);
	}
}

try {
	await fixture.withBinding(rootCell, async binding => {
		try {
		stage = "sdk-root";
		const root = await createAgentSession({
			cwd: directory, agentDir: path.join(directory, "agent"), sessionManager: manager,
			authStorage, modelRegistry, settings, bindProcessState: false,
			extensions: [], disableExtensionDiscovery: true, skills: [], rules: [], contextFiles: [],
			promptTemplates: [], slashCommands: [], enableMCP: false, enableLsp: false,
			skipPythonPreflight: true, agentId: "WarmRootR", modelRequestJournalLeaseBinding: binding,
		});
		rootSession = root.session;
		const handover = root.session.childModelRequestRoot();
		const parent = handover.parentExecution;
		assert(parent !== undefined);
		assertJournalExecutionReady(parent);
		assert.equal(parent.journalState, "required-ready");
		assert.equal(parent.modelRequestJournalLeaseBinding, binding);
		const spawn = async (id: string) => {
			const result = await root.session.runInModelRequestContext(() => runSubprocess({
				cwd: directory, artifactsDir: path.join(directory, "artifacts"),
				agent: { name: "task", description: "native warm parent regression", systemPrompt: "test", tools: ["write"], source: "bundled" },
				task: "report done", index: id === A ? 0 : 1, id, parentAgentId: "WarmRootR",
				modelOverride: "openai/gpt-4o-mini", authStorage, modelRegistry, settings,
				modelRequestRoot: handover, enableLsp: false, enableMCP: false, enableIrc: true,
				inheritedSessionAgents: [], skills: [], rules: [], contextFiles: [], promptTemplates: [],
				preloadedExtensionPaths: [], preloadedPreparedExtensions: [], preloadedCustomToolPaths: [],
			}));
			assert.equal(result.exitCode, 0, JSON.stringify(result));
			const session = AgentRegistry.global().get(id)?.session;
			assert(session, `${id} was not adopted after its real executor turn`);
			const execution = session.childModelRequestRoot().parentExecution;
			assert(execution !== undefined);
			assertJournalExecutionReady(execution);
			assert.equal(execution.journalState, "required-ready");
			assert.equal(execution.modelRequestJournalLeaseBinding, binding);
			assert.equal(resolveModelRequestScope(execution).rootSessionId, manager.getSessionId());
			assert.throws(() => assertJournalExecutionIdentity(parent, execution), unavailable);
			return { session, execution };
		};
		stage = "executor-A";
		const a = await spawn(A);
		stage = "executor-B";
		const b = await spawn(B);
		assert.throws(() => assertJournalExecutionIdentity(a.execution, b.execution), unavailable);
		assert(a.session.sessionManager.getEntries().some(entry => entry.type === "message"));
		const aFile = a.session.sessionManager.getSessionFile();
		assert(aFile !== undefined);
		stage = "park-A";
		await AgentLifecycleManager.global().park(A);
		assert.equal(AgentRegistry.global().get(A)?.status, "parked");
		assert.equal(AgentRegistry.global().get(A)?.session, null);
		assert(AgentLifecycleManager.global().has(A), "executor's actual saved warm reviver must remain adopted");
		assertJournalExecutionReady(parent);
		assertJournalExecutionReady(b.execution);
		// The direct wrong-family resolver stays forbidden: the legitimate consumer must rebind R itself.
		b.session.runInModelRequestContext(() => {
			assert.equal(getModelRequestExecution(), b.execution);
			assert.throws(() => resolveModelRequestRootSource(handover), unavailable);
		});
		const unsubscribe = b.session.subscribe(event => {
			if (event.type === "tool_execution_start" && event.toolName === "write") {
				const active = getModelRequestExecution();
				assert(active !== undefined, "actual write turn lost its execution");
				assertJournalExecutionIdentity(b.execution, active);
				writeStartedUnderB = true;
			}
			if (event.type === "tool_execution_end" && event.toolName === "write") {
				writeFailed = event.isError;
				writeResult = event.result;
			}
		});
		stage = "B-turn-agent-url-warm-revive";
		console.log(JSON.stringify({ stage, rootReady: parent.journalState, bReady: b.execution.journalState,
			sameBinding: parent.modelRequestJournalLeaseBinding === b.execution.modelRequestJournalLeaseBinding,
			savedParent: handover.parentExecution === parent, parkedHistory: aFile, adopted: true, wrongFamilyDirectRejected: true }));
		try { await b.session.prompt(WAKE); }
		finally { unsubscribe(); }
		assert(writeStartedUnderB, "write must execute under B's actual core turn context");
		assert.equal(writeFailed, false, `actual agent://A write failed: ${JSON.stringify(writeResult)}`);
		const revived = AgentRegistry.global().get(A)?.session;
		assert(revived, "actual saved warm reviver did not attach A");
		assert.notEqual(revived, a.session);
		assert.equal(revived.sessionManager.getSessionFile(), aFile);
		assertJournalExecutionReady(revived.childModelRequestRoot().parentExecution);
		await waitForIdle(revived);
		b.session.runInModelRequestContext(() => assert.throws(() => resolveModelRequestRootSource(handover), unavailable));
		stage = "outside-ALS-warm-revive";
		assert.equal(getModelRequestExecution(), undefined);
		await AgentLifecycleManager.global().park(A);
		const outside = await AgentLifecycleManager.global().ensureLive(A);
		assertJournalExecutionReady(outside.childModelRequestRoot().parentExecution);
		console.log(JSON.stringify({ stage: "complete", writeStartedUnderB, writeFailed, wrongFamilyDirectRejected: true,
			outsideAlsReady: true, wireRequests: server.requests.length }));
		} finally {
			await AgentLifecycleManager.global().dispose();
			await rootSession?.dispose();
			rootSession = undefined;
		}
	});
	console.log("model-request-warm-parent:ok");
} catch (error) {
	console.error(JSON.stringify({ stage, writeStartedUnderB, writeFailed, writeResult }));
	throw error;
} finally {
	await AgentLifecycleManager.global().dispose();
	await rootSession?.dispose();
	await manager.close();
	modelRegistry.clearSourceRegistrations("<inline-0>");
	authStorage.close();
	server.stop();
	AgentStorage.close();
	closeModelCache();
	await fixture.close();
}
