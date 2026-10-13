import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import {
	createModelRequestSessionExecution,
	getModelRequestExecution,
	resolveModelRequestScope,
	runWithModelRequestExecution,
} from "@oh-my-pi/pi-ai/model-request-execution";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../src/config/settings";
import type { ModelRegistry } from "../src/config/model-registry";
import * as consolidate from "../src/sharpshooter/consolidate";
import { startSharpshooterScheduler } from "../src/sharpshooter/scheduler";

/** Which session's model-request context a consolidation ran under (undefined: none). */
function attributedSession(): string | undefined {
	const execution = getModelRequestExecution();
	return execution === undefined ? undefined : resolveModelRequestScope(execution).sessionId;
}

function hostExecution(sessionId: string) {
	return createModelRequestSessionExecution({
		getSessionId: () => sessionId,
		root: { kind: "self" },
		agent: { id: sessionId, kind: "main", name: sessionId, depth: 0 },
	});
}

describe("sharpshooter scheduler on a bank shared by several sessions", () => {
	const disposers: Array<() => void> = [];
	let tempDir: TempDir | undefined;

	afterEach(() => {
		for (const dispose of disposers.splice(0)) dispose();
		tempDir?.removeSync();
		tempDir = undefined;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("attributes a tick to a live session once the session that started the interval is gone", async () => {
		vi.useFakeTimers();
		tempDir = TempDir.createSync("@pi-sharpshooter-scheduler-");
		const attributed: Array<string | undefined> = [];
		let tickRan = Promise.withResolvers<void>();
		vi.spyOn(consolidate, "runSharpshooterConsolidation").mockImplementation(async () => {
			attributed.push(attributedSession());
			tickRan.resolve();
			return { ran: false, reason: "error", error: "stubbed" };
		});
		const agentDir = path.join(tempDir.path(), "agent");
		const startAs = (sessionId: string) =>
			runWithModelRequestExecution(hostExecution(sessionId), () =>
				startSharpshooterScheduler({
					agentDir,
					cwd: tempDir?.path() ?? "",
					settings: Settings.isolated(),
					modelRegistry: {} as unknown as ModelRegistry,
					sessionId,
				}),
			);

		const disposeA = startAs("session-A");
		disposers.push(disposeA);
		disposers.push(startAs("session-B"));
		await tickRan.promise; // the starter's immediate tick
		tickRan = Promise.withResolvers<void>();

		disposeA(); // A ends while B keeps the shared interval alive
		vi.advanceTimersByTime(60_000);
		await tickRan.promise;

		expect(attributed).toEqual(["session-A", "session-B"]);
	});
});
