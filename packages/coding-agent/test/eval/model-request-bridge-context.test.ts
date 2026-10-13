/**
 * Eval cells run outside the host's async context (a JS worker's messages, a Python kernel's loopback HTTP
 * requests), so a host call a cell makes (`agent()`, `completion()`, any tool) must be served inside the context of
 * the session that started the cell. Otherwise the model request it issues reaches the gate with no origin at all.
 */
import { afterAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import {
	getModelRequestExecution,
	resolveModelRequestScope,
	runWithModelRequestExecution,
} from "@oh-my-pi/pi-ai/model-request-execution";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { executeJs } from "@oh-my-pi/pi-coding-agent/eval/js/executor";
import {
	disposePyToolBridge,
	ensurePyToolBridge,
	registerPyToolBridge,
} from "@oh-my-pi/pi-coding-agent/eval/py/tool-bridge";
import { createSessionModelRequestExecution } from "@oh-my-pi/pi-coding-agent/session/model-request-context";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

const NO_CONTEXT = "no-context";

/** A tool that reports the session id of the context its `execute` runs in. */
function probeTool(seen: string[]): AgentTool {
	return {
		name: "probe",
		label: "probe",
		description: "reports the active model-request context",
		parameters: { type: "object" },
		async execute(): Promise<AgentToolResult> {
			const execution = getModelRequestExecution();
			seen.push(execution === undefined ? NO_CONTEXT : resolveModelRequestScope(execution).sessionId);
			return { content: [{ type: "text", text: "probed" }] };
		},
	} as unknown as AgentTool;
}

function hostExecution(sessionId: string) {
	return createSessionModelRequestExecution({
		getSessionId: () => sessionId,
		agent: { id: "Main", kind: "main", name: "main", depth: 0 },
		modelRequestRoot: undefined,
	});
}

describe("eval host calls re-enter the starting session's model-request context", () => {
	afterAll(async () => {
		await disposeAllVmContexts();
		await disposePyToolBridge();
	});

	it("serves a call made from a JS worker cell inside the host session's context", async () => {
		using tempDir = TempDir.createSync("@omp-eval-request-context-js-");
		const seen: string[] = [];
		const probe = probeTool(seen);
		const session = {
			cwd: tempDir.path(),
			settings: Settings.isolated(),
			getToolByName: (name: string) => (name === "probe" ? probe : undefined),
		} as unknown as ToolSession;

		const result = await runWithModelRequestExecution(hostExecution("host-session-js"), () =>
			executeJs("return await tool.probe({});", {
				cwd: tempDir.path(),
				sessionId: `js-request-context:${crypto.randomUUID()}`,
				session,
				sessionFile: path.join(tempDir.path(), "session.jsonl"),
			}),
		);

		expect(result.exitCode).toBe(0);
		expect(seen).toEqual(["host-session-js"]);
	}, 30_000);

	it("serves a Python loopback call inside the context active when the cell registered its bridge", async () => {
		const seen: string[] = [];
		const probe = probeTool(seen);
		const session = {
			getToolByName: (name: string) => (name === "probe" ? probe : undefined),
		} as unknown as ToolSession;
		const info = await ensurePyToolBridge();
		const sessionId = `py-request-context-${crypto.randomUUID()}`;
		const unregister = runWithModelRequestExecution(hostExecution("host-session-py"), () =>
			registerPyToolBridge(sessionId, "run-1", { toolSession: session }),
		);
		try {
			// The kernel's HTTP request arrives on the server's own task, outside any session context.
			const response = await fetch(`${info.url}/v1/tool`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${info.token}` },
				body: JSON.stringify({ session: sessionId, run: "run-1", name: "probe", args: {} }),
			});

			expect(await response.json()).toEqual({ ok: true, value: "probed" });
			expect(seen).toEqual(["host-session-py"]);
		} finally {
			unregister();
		}
	});
});
