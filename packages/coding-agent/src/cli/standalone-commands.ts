/**
 * Which top-level commands never create an agent session.
 *
 * A process running such a command is marked a session-less ("standalone") process before the command runs, so a
 * model request it makes is classified by the core as standalone instead of unclassified. The mark is a latch: a
 * marked process refuses to create a session afterwards, so a command listed here by mistake fails loudly the
 * first time it creates one. Be conservative: a command that creates a session on ANY of its code paths belongs in
 * {@link SESSION_COMMANDS}, never here.
 *
 * Every command registered in `cli-commands.ts` must appear in exactly one of the two tables; the unit test over
 * the registry fails when a new command is added without being classified. Aliases follow their command.
 */
import type { CommandEntry } from "@oh-my-pi/pi-utils/cli";

/**
 * Commands that never create an agent session, directly (`createAgentSession`, `new AgentSession`) or through a
 * helper (`runRootCommand`, `runStructuredSubagent`, commit agent, compress session, security scan, task executor).
 * They may still call a model directly (`completeSimple`, `streamSimple`, standalone judge, speech, images).
 */
const SESSIONLESS_COMMANDS: Readonly<Record<string, true>> = {
	"auth-broker": true,
	"auth-gateway": true,
	agents: true,
	anonymize: true,
	bench: true,
	"browser-relay": true,
	clip: true,
	collab: true,
	completions: true,
	__complete: true,
	config: true,
	"dry-balance": true,
	find: true,
	gc: true,
	grep: true,
	gallery: true,
	git: true,
	grievances: true,
	images: true,
	"if-bench": true,
	install: true,
	login: true,
	models: true,
	plugin: true,
	predict: true,
	ps: true,
	say: true,
	play: true,
	share: true,
	shell: true,
	read: true,
	skill: true,
	ssh: true,
	stats: true,
	stream: true,
	update: true,
	usage: true,
	"tiny-models": true,
	token: true,
	toks: true,
	ttsr: true,
	worktree: true,
	search: true,
};

/**
 * Commands that create, or on some path may create, an agent session. Never marked.
 *
 * - `launch`, `acp`, `join`: run the root command (interactive, print, rpc, acp, collab guest).
 * - `setup`: the onboarding wizard (no component argument) runs the root command.
 * - `commit`: the commit agent runs in an agent session.
 * - `compress`: runs a compress session.
 * - `cleanse`: drives structured subagents (child sessions).
 * - `render`: builds an `AgentSession` to replay a transcript.
 */
const SESSION_COMMANDS: Readonly<Record<string, true>> = {
	launch: true,
	acp: true,
	join: true,
	setup: true,
	commit: true,
	compress: true,
	cleanse: true,
	render: true,
};

export type CommandSessionClass = "sessionless" | "session" | "unclassified";

type CommandNames = Pick<CommandEntry, "name" | "aliases">;

/**
 * Classify the top-level command a resolved argv starts with (`resolveCliArgv(...).argv[0]`), resolving aliases
 * through `table`. A token that is not a registered command, and a registered command missing from both tables,
 * is `unclassified` and is treated as session-capable.
 */
export function commandSessionClass(token: string | undefined, table: readonly CommandNames[]): CommandSessionClass {
	if (token === undefined) return "unclassified";
	const entry = table.find(candidate => candidate.name === token || candidate.aliases?.includes(token) === true);
	if (entry === undefined) return "unclassified";
	if (Object.hasOwn(SESSIONLESS_COMMANDS, entry.name)) return "sessionless";
	if (Object.hasOwn(SESSION_COMMANDS, entry.name)) return "session";
	return "unclassified";
}

/** Whether the command a resolved argv starts with never creates an agent session. */
export function isSessionlessCommand(token: string | undefined, table: readonly CommandNames[]): boolean {
	return commandSessionClass(token, table) === "sessionless";
}
