import { Agent, type AgentEvent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-utils/model-data";
import { runWithModelRequestExecution } from "@oh-my-pi/pi-ai/model-request-execution";
import {
	beginJournalBindingWork,
	endJournalWork,
	type FileJournalCell,
	type ModelRequestExecution,
} from "@oh-my-pi/pi-utils/model-request-journal-composition";
import type { ModelRequestJournalLeaseBinding } from "@oh-my-pi/pi-utils/model-request-journal-authority";
import type { ModelRequestRegistryEntry } from "@oh-my-pi/pi-utils/session-entries";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "../../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../../src/extensibility/extensions/runner";
import type { ExtensionAPI } from "../../src/extensibility/extensions/types";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { EventBus } from "../../src/utils/event-bus";
import type { ReadyPrincipal } from "../../../utils/test/fixtures/model-request-journal-r11";

export function closedSessionIds(cell: FileJournalCell): string[] {
	return cell
		.getEntries()
		.filter((entry): entry is ModelRequestRegistryEntry => entry.type === "model_request_registry")
		.filter(entry => entry.record.event === "owner-closed")
		.map(entry => entry.record.sessionId);
}

export function expectBindingAcceptsOuterWork(binding: ModelRequestJournalLeaseBinding): void {
	const handle = beginJournalBindingWork(binding);
	endJournalWork(handle, { type: "fulfilled" });
}

export interface ManagedAgentHarness {
	readonly principal: ReadyPrincipal;
	readonly binding: ModelRequestJournalLeaseBinding;
	readonly session: AgentSession;
	readonly api: ExtensionAPI;
	readonly agent: Agent;
	readonly runner: ExtensionRunner;
	readonly authStorage: AuthStorage;
	emitMessageUpdate(delta: string): void;
	emitMessageEnd(message?: AssistantMessage): void;
	dispose(): Promise<void>;
}

export async function openManagedAgentHarness(
	principal: ReadyPrincipal,
	binding: ModelRequestJournalLeaseBinding,
	options: { settings?: Settings } = {},
): Promise<ManagedAgentHarness> {
	const runtime = new ExtensionRuntime();
	const sessionFile = principal.cell.getSessionFile();
	if (!sessionFile) throw new Error("managed harness requires a File session");
	const manager = await SessionManager.open(sessionFile, undefined, undefined, { suppressBreadcrumb: true });
	let api!: ExtensionAPI;
	const extension = await loadExtensionFromFactory(
		extensionApi => {
			api = extensionApi;
		},
		manager.getCwd(),
		new EventBus(),
		runtime,
	);
	const authStorage = await AuthStorage.create(":memory:");
	const registry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
	const runner = new ExtensionRunner([extension], runtime, manager.getCwd(), manager, registry);
	runner.setModelRequestExecution(principal.execution);
	const agent = new Agent({ initialState: { systemPrompt: [], tools: [], messages: [] } });
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings:
			options.settings ??
			Settings.isolated({ "compaction.enabled": false, "memory.enabled": false }),
		modelRegistry: registry,
		extensionRunner: runner,
		modelRequestExecution: principal.execution,
	});
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "x" }],
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	return {
		principal,
		binding,
		session,
		api,
		agent,
		runner,
		authStorage,
		emitMessageUpdate(delta: string) {
			const update: AgentEvent = {
				type: "message_update",
				message: assistant,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: assistant },
			};
			agent.emitExternalEvent(update);
		},
		emitMessageEnd(message = assistant) {
			agent.emitExternalEvent({ type: "message_end", message });
		},
		async dispose() {
			await session.dispose();
			authStorage.close();
		},
	};
}

export async function withManagedExecution<T>(
	execution: ModelRequestExecution,
	work: () => Promise<T>,
): Promise<T> {
	return runWithModelRequestExecution(execution, work);
}
