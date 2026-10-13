/**
 * The computer worker is a separate thread: its `tool-call` messages arrive on the supervisor's own message
 * handler, outside the async context of the tool call that started the run. A host call the desktop script makes
 * (`completion()`, `agent()`, ...) must still be served inside that tool call's model-request context, otherwise the
 * model request it issues reaches the gate with no origin at all.
 */
import { describe, expect, it } from "bun:test";
import {
	getModelRequestExecution,
	resolveModelRequestScope,
	runWithModelRequestExecution,
} from "@oh-my-pi/pi-ai/model-request-execution";
import { createSessionModelRequestExecution } from "@oh-my-pi/pi-coding-agent/session/model-request-context";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type {
	ComputerRunOk,
	ComputerSessionSnapshot,
	ComputerWorkerInbound,
	ComputerWorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/tools/computer/protocol";
import {
	ComputerSupervisor,
	type ComputerSessionToolCaller,
	type ComputerWorkerHandle,
} from "@oh-my-pi/pi-coding-agent/tools/computer/supervisor";

const SNAPSHOT: ComputerSessionSnapshot = {
	cwd: "/tmp",
	sessionId: "computer-test",
	captureMaxWidth: 1024,
	captureMaxHeight: 768,
	display: "main",
	readOnly: true,
};
const RUN_OK: ComputerRunOk = { displays: [], returnValue: "ok", screenshots: [] };
const NO_CONTEXT = "no-context";

/** A worker whose outbound messages the test emits by hand, from the test's own (context-free) flow. */
class ScriptedWorker implements ComputerWorkerHandle {
	readonly sent: ComputerWorkerInbound[] = [];
	readonly #handlers = new Set<(message: ComputerWorkerOutbound) => void>();
	readonly #runSent = Promise.withResolvers<string>();
	readonly #replySent = Promise.withResolvers<void>();

	send(message: ComputerWorkerInbound): void {
		this.sent.push(message);
		if (message.type === "run") this.#runSent.resolve(message.id);
		if (message.type === "tool-reply") this.#replySent.resolve();
		if (message.type === "close") this.emit({ type: "closed" });
	}

	onMessage(handler: (message: ComputerWorkerOutbound) => void): () => void {
		this.#handlers.add(handler);
		return () => this.#handlers.delete(handler);
	}

	onError(): () => void {
		return () => {};
	}

	async terminate(): Promise<void> {}

	/** Resolves with the id of the run the supervisor sent. */
	get runId(): Promise<string> {
		return this.#runSent.promise;
	}

	/** Resolves once the supervisor answered a worker tool call. */
	get toolReply(): Promise<void> {
		return this.#replySent.promise;
	}

	emit(message: ComputerWorkerOutbound): void {
		for (const handler of this.#handlers) handler(message);
	}
}

describe("computer worker tool calls", () => {
	it("are served inside the model-request context of the tool call that started the run", async () => {
		const worker = new ScriptedWorker();
		const seen: string[] = [];
		const callTool: ComputerSessionToolCaller = async () => {
			const execution = getModelRequestExecution();
			seen.push(execution === undefined ? NO_CONTEXT : resolveModelRequestScope(execution).sessionId);
			return "tool-value";
		};
		const supervisor = new ComputerSupervisor({} as unknown as ToolSession, () => worker, undefined, callTool);
		const host = createSessionModelRequestExecution({
			getSessionId: () => "computer-host-session",
			agent: { id: "Main", kind: "main", name: "main", depth: 0 },
			root: { kind: "self" },
		});

		const run = runWithModelRequestExecution(host, () => supervisor.run("return 1;", 5_000, SNAPSHOT));
		// Everything below runs outside the host context, like the worker's own message delivery.
		expect(getModelRequestExecution()).toBeUndefined();
		worker.emit({ type: "ready" });
		const runId = await worker.runId;
		worker.emit({ type: "tool-call", id: "call-1", runId, name: "completion", args: {} });
		await worker.toolReply;
		worker.emit({ type: "result", id: runId, ok: true, payload: RUN_OK });
		await run;

		expect(seen).toEqual(["computer-host-session"]);
		expect(worker.sent.find(message => message.type === "tool-reply")).toEqual({
			type: "tool-reply",
			id: "call-1",
			reply: { ok: true, value: "tool-value" },
		});
		await supervisor.close();
	});
});
