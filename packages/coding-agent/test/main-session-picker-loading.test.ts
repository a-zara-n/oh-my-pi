import { expect, it, vi } from "bun:test";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import * as pickerModule from "@oh-my-pi/pi-tui/apps/session-picker";
import { TempDir } from "@oh-my-pi/pi-utils";
import { __resetDirsFromEnvForTests, getProjectDir, setAgentDir, setProjectDir } from "@oh-my-pi/pi-utils/dirs";

it("loads the native resume picker dependencies and supplies working file storage", async () => {
	using tempDir = TempDir.createSync("@omp-picker-loading-");
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalProjectDir = getProjectDir();
	const agentDir = tempDir.join("agent");
	const sessionDir = tempDir.join("sessions");
	const sessionPath = path.join(sessionDir, "picker-session.jsonl");
	const sessionId = "picker-session";
	const timestamp = new Date().toISOString();
	await Bun.write(
		sessionPath,
		[
			JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: tempDir.path(), timestamp }),
			JSON.stringify({
				type: "message",
				id: "user",
				parentId: null,
				timestamp,
				message: { role: "user", content: "prior question" },
			}),
			JSON.stringify({
				type: "message",
				id: "assistant",
				parentId: "user",
				timestamp,
				message: { role: "assistant", content: "prior answer" },
			}),
			"",
		].join("\n"),
	);
	await Bun.write(path.join(agentDir, "session-pins.json"), JSON.stringify([sessionId]));
	const authStorage = await AuthStorage.create(":memory:");
	const stopBeforePresentation = new Error("picker dependencies loaded");
	// Keep the actual runRootCommand loader and storage graph. Only the TUI
	// presentation export is intercepted, so no terminal or model is started.
	const presentation = vi.spyOn(pickerModule, "selectSession").mockImplementation(async (sessions, _options, host) => {
		expect(sessions).toHaveLength(1);
		expect(sessions[0].id).toBe(sessionId);
		expect(sessions[0].path).toBe(sessionPath);
		expect(await host?.loadPinnedIds?.()).toEqual(new Set([sessionId]));
		expect(host?.loadHistoryMatcher).toBeFunction();
		expect(host?.loadAllSessions).toBeFunction();
		expect(await host?.deleteSession?.(sessions[0])).toBe(true);
		expect(await Bun.file(sessionPath).exists()).toBe(false);
		throw stopBeforePresentation;
	});
	try {
		setAgentDir(agentDir);
		const rawArgs = [
			"--cwd",
			tempDir.path(),
			"--session-dir",
			sessionDir,
			"--resume",
			"--print",
			"--no-extensions",
			"--no-skills",
			"--no-rules",
			"--no-tools",
			"--no-lsp",
		];
		await expect(
			runRootCommand(parseArgs(rawArgs), rawArgs, {
				discoverAuthStorage: async () => authStorage,
				settings: Settings.isolated({ "marketplace.autoUpdate": "off" }),
			}),
		).rejects.toBe(stopBeforePresentation);
		expect(presentation).toHaveBeenCalledTimes(1);
	} finally {
		presentation.mockRestore();
		authStorage.close();
		setProjectDir(originalProjectDir);
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		__resetDirsFromEnvForTests();
	}
}, 15_000);
