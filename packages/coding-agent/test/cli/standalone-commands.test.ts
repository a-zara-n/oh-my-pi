/**
 * Which commands run a process that never creates an agent session.
 *
 * A process marked session-less refuses to create a session afterwards, so a command that DOES create one must never
 * be classified session-less. These tests pin the table from the resolved argv the CLI entry actually inspects.
 */
import { describe, expect, test } from "bun:test";
import { commands, resolveCliArgv } from "@oh-my-pi/pi-coding-agent/cli-commands";
import { commandSessionClass, isSessionlessCommand } from "@oh-my-pi/pi-coding-agent/cli/standalone-commands";

/** The command token the CLI entry classifies for `argv`, exactly as `runCli` resolves it. */
function resolvedCommand(argv: string[]): string | undefined {
	const resolved = resolveCliArgv(argv);
	if ("error" in resolved) throw new Error(resolved.error);
	return resolved.argv[0];
}

describe("isSessionlessCommand", () => {
	test("commands that create or may create an agent session are never session-less", () => {
		const sessionCapable = ["launch", "acp", "join", "setup", "commit", "compress", "cleanse", "render"];
		for (const name of sessionCapable) {
			expect(isSessionlessCommand(name, commands), name).toBe(false);
			expect(commandSessionClass(name, commands), name).toBe("session");
		}
	});

	test("commands that only call a model directly or touch local state are session-less", () => {
		const sessionless = [
			"auth-gateway",
			"bench",
			"dry-balance",
			"find",
			"git",
			"models",
			"read",
			"search",
			"stats",
			"update",
			"worktree",
		];
		for (const name of sessionless) expect(isSessionlessCommand(name, commands), name).toBe(true);
	});

	test("an alias is classified like its command", () => {
		for (const entry of commands) {
			const expected = isSessionlessCommand(entry.name, commands);
			for (const alias of entry.aliases ?? []) {
				expect(isSessionlessCommand(alias, commands), `${alias} -> ${entry.name}`).toBe(expected);
			}
		}
		expect(isSessionlessCommand("img", commands)).toBe(true);
		expect(isSessionlessCommand("wt", commands)).toBe(true);
		expect(isSessionlessCommand("q", commands)).toBe(true);
	});

	test("every registered command is classified, so a new command cannot be forgotten", () => {
		const unclassified = commands.filter(entry => commandSessionClass(entry.name, commands) === "unclassified");
		expect(unclassified.map(entry => entry.name)).toEqual([]);
	});

	test("anything that is not a registered command is not session-less", () => {
		expect(isSessionlessCommand(undefined, commands)).toBe(false);
		expect(isSessionlessCommand("", commands)).toBe(false);
		expect(isSessionlessCommand("not-a-command", commands)).toBe(false);
		expect(isSessionlessCommand("--help", commands)).toBe(false);
		expect(isSessionlessCommand("find", [])).toBe(false);
	});

	test("a prompt, or flags before a subcommand, resolve to the command the entry classifies", () => {
		// No subcommand: the argv is forwarded to launch, which creates the session.
		expect(isSessionlessCommand(resolvedCommand(["fix the failing test"]), commands)).toBe(false);
		expect(isSessionlessCommand(resolvedCommand(["--model", "x", "-p", "hello"]), commands)).toBe(false);
		expect(isSessionlessCommand(resolvedCommand([]), commands)).toBe(false);
		// A subcommand behind leading global flags is hoisted to the front before it is classified.
		expect(isSessionlessCommand(resolvedCommand(["--approval-mode=yolo", "acp"]), commands)).toBe(false);
		expect(isSessionlessCommand(resolvedCommand(["--cwd", "/tmp", "update"]), commands)).toBe(true);
		expect(isSessionlessCommand(resolvedCommand(["auth-gateway", "--help"]), commands)).toBe(true);
	});
});
