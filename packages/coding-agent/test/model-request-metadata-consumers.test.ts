import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { TreeSelectorComponent } from "@oh-my-pi/pi-tui/overlays/tree-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { parseSessionFile } from "../../stats/src/parser";
import { reconstructControlState } from "../src/autoresearch/state";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { buildSessionData, exportFromFile } from "../src/export/html";
import { buildShareSnapshot } from "../src/export/share";
import { countUserTurns, extractMessages } from "../src/hindsight/transcript";
import { formatCurrentBranchFullHistory } from "../src/internal-urls/history-protocol";
import { selectRpcEntries } from "../src/modes/rpc/rpc-compat";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { completedRewindFromEntry, isSuccessfulCheckpointEntry } from "../src/session/checkpoint-entries";
import { ClaudeSessionStore } from "../src/session/claude-session-store";
import { CodexSessionStore } from "../src/session/codex-session-store";
import { getContextNotes } from "../src/session/context-notes";
import { collectPendingToolCalls, createInterruptedTurnAbortMessage } from "../src/session/exit-diagnostics";
import { readModelMentions } from "../src/session/model-mentions";
import { anonymizeSessionTranscripts, SessionAnonymizer } from "../src/session/session-anonymizer";
import { buildSessionContext, isTranscriptEntry } from "../src/session/session-context";
import { formatSessionDumpText } from "../src/session/session-dump-format";
import type { ModelRequestMetadataEntry, SessionEntry, SessionHeader } from "../src/session/session-entries";
import { formatSessionHistoryMarkdown } from "../src/session/session-history-format";
import { readSessionInfo } from "../src/session/session-listing";
import { SessionManager } from "../src/session/session-manager";
import { collectSubSessions } from "../src/session/sub-sessions";
import { getLatestTodoPhasesFromEntries } from "../src/tools/todo";

const timestamp = "2026-10-16T00:00:00.000Z";
const journalId = "11111111-1111-4111-8111-111111111111";
const journalOwnerId = "22222222-2222-4222-8222-222222222222";
const journalEpoch = "33333333-3333-4333-8333-333333333333";
const promptCanary = "PROMPT_CANARY_DO_NOT_DUPLICATE";
const keyCanary = "KEY_CANARY_DO_NOT_DUPLICATE";

function fixture(cwd: string, id = "consumer-session"): {
	header: SessionHeader;
	entries: SessionEntry[];
	metadata: ModelRequestMetadataEntry;
} {
	const header: SessionHeader = {
		type: "session", version: 3, id, timestamp, cwd,
		modelRequestJournal: { schemaVersion: 1, journalId, sessionId: id, epochs: [{ journalOwnerId, journalEpoch }] },
	};
	const entries: SessionEntry[] = [
		{ type: "message", id: "user0001", parentId: null, timestamp,
			message: { role: "user", content: promptCanary, timestamp: 1 } },
		{ type: "message", id: "asst0001", parentId: "user0001", timestamp,
			message: { role: "assistant", content: [{ type: "text", text: keyCanary }],
				api: "openai-completions", provider: "openai", model: "gpt-4o-mini", stopReason: "stop", timestamp: 2,
				usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
					cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } } } },
	];
	const metadata: ModelRequestMetadataEntry = {
		type: "model_request_metadata", id: "meta0001", parentId: null, timestamp,
		schemaVersion: 1, journalId, sessionId: id, journalOwnerId, journalEpoch, seq: 1,
		record: { schemaVersion: 1, sourceKind: "assistant", sourceSessionId: id, sourceEntryId: "asst0001",
			resultId: null, provenance: { kind: "non-wire", reason: "local" } },
	};
	return { header, entries, metadata };
}

function jsonl(header: SessionHeader, entries: readonly SessionEntry[]): string {
	return `${[header, ...entries].map(record => JSON.stringify(record)).join("\n")}\n`;
}

describe("model-request metadata consumer cutover", () => {
	test("trailing metadata cannot replace the branch/context fallback, including legacy and transcript replay", () => {
		const { entries, metadata } = fixture("/tmp");
		const legacy = buildSessionContext(entries);
		const canonical = [...entries, metadata];
		expect(buildSessionContext(canonical)).toEqual(legacy);
		expect(buildSessionContext(canonical, metadata.id)).toEqual(legacy);
		expect(buildSessionContext(canonical, "missing")).toEqual(legacy);
		expect(buildSessionContext(canonical, null).messages).toEqual([]);
		expect(buildSessionContext([metadata]).messages).toEqual([]);
		expect(buildSessionContext(canonical, undefined, undefined, { transcript: true })).toEqual(
			buildSessionContext(entries, undefined, undefined, { transcript: true }),
		);
		expect(canonical.filter(isTranscriptEntry)).toEqual(entries.filter(isTranscriptEntry));
		expect(JSON.stringify(metadata)).not.toContain(promptCanary);
		expect(JSON.stringify(metadata)).not.toContain(keyCanary);
	});

	test("canonical RPC keeps metadata as a cursor while model-facing history and dumps omit it", () => {
		const { entries, metadata } = fixture("/tmp");
		const canonical = [...entries, metadata];
		expect(selectRpcEntries(canonical, "asst0001").entries).toEqual(canonical);
		expect(selectRpcEntries(canonical, "asst0001", "asst0001").entries).toEqual([metadata]);
		expect(selectRpcEntries(canonical, "asst0001", metadata.id)).toEqual({ entries: [], leafId: "asst0001" });
		const fullHistory = formatCurrentBranchFullHistory(canonical);
		expect(fullHistory).toEqual(formatCurrentBranchFullHistory(entries));
		expect(fullHistory).not.toContain("model_request_metadata");
		expect(fullHistory).not.toContain(journalOwnerId);
		const messages = buildSessionContext(canonical).messages;
		expect(formatSessionHistoryMarkdown(messages)).toEqual(formatSessionHistoryMarkdown(buildSessionContext(entries).messages));
		expect(formatSessionDumpText({ messages })).toEqual(formatSessionDumpText({ messages: buildSessionContext(entries).messages }));
	});

	test("custom/message state readers ignore appended metadata rather than changing latest state", () => {
		const { entries, metadata } = fixture("/tmp");
		const states: SessionEntry[] = [
			...entries,
			{ type: "custom", id: "control1", parentId: "asst0001", timestamp, customType: "autoresearch-control", data: { mode: "on", goal: "retain goal" } },
			{ type: "custom", id: "notes001", parentId: "control1", timestamp, customType: "experimental_context_notes", data: { version: 1, text: "retain notebook" } },
			{ type: "custom", id: "mention1", parentId: "notes001", timestamp, customType: "model_mention", data: { agent: "m1", selector: "openai/gpt-4o-mini", name: "mini" } },
			{ type: "custom", id: "todos001", parentId: "mention1", timestamp, customType: "user_todo_edit", data: { phases: [{ name: "retain phase", tasks: [{ content: "retain task", status: "pending" }] }] } },
		];
		const canonical = [...states, metadata];
		expect(reconstructControlState(canonical)).toEqual(reconstructControlState(states));
		expect(getContextNotes(canonical)).toEqual({ entryId: "notes001", text: "retain notebook" });
		expect(readModelMentions(canonical)).toEqual(readModelMentions(states));
		expect(getLatestTodoPhasesFromEntries(canonical)).toEqual(getLatestTodoPhasesFromEntries(states));
		expect(getLatestTodoPhasesFromEntries(canonical)[0]?.tasks[0]?.content).toBe("retain task");
		expect(collectPendingToolCalls(canonical)).toEqual(collectPendingToolCalls(states));
		expect(createInterruptedTurnAbortMessage(canonical)).toEqual(createInterruptedTurnAbortMessage(states));
		expect(isSuccessfulCheckpointEntry(metadata)).toBe(false);
		expect(completedRewindFromEntry(metadata)).toBeUndefined();
		expect(extractMessages({ getEntries: () => canonical })).toEqual(extractMessages({ getEntries: () => states }));
		expect(countUserTurns({ getEntries: () => canonical })).toBe(1);
	});

	test("pending tools and interrupted-turn recovery use the last message rather than trailing metadata", () => {
		const { entries, metadata } = fixture("/tmp");
		const assistant = entries[1];
		if (assistant.type !== "message" || assistant.message.role !== "assistant") throw new Error("Expected assistant");
		const pending: SessionEntry[] = [
			entries[0],
			{ ...assistant, message: { ...assistant.message, stopReason: "toolUse", content: [{ type: "toolCall", id: "pending-tool", name: "read", arguments: { path: "/tmp/input" } }] } },
			{ type: "custom", id: "exit0001", parentId: assistant.id, timestamp, customType: "session_exit", data: { reason: "SIGTERM", kind: "signal", recordedAt: timestamp } },
		];
		expect(collectPendingToolCalls(pending)).toHaveLength(1);
		expect(collectPendingToolCalls([...pending, metadata])).toEqual(collectPendingToolCalls(pending));
		expect(createInterruptedTurnAbortMessage(pending)?.stopReason).toBe("aborted");
		expect(createInterruptedTurnAbortMessage([...pending, metadata])).toEqual(createInterruptedTurnAbortMessage(pending));
	});

	test("foreign import rejects descriptor or metadata before converting to a new unmanaged identity", async () => {
		await using dir = await TempDir.create("@metadata-import-");
		const { header, metadata } = fixture(dir.path());
		for (const [index, records] of [[header], [metadata]].entries()) {
			const file = path.join(dir.path(), `foreign-${index}.jsonl`);
			const body = `${records.map(record => JSON.stringify(record)).join("\n")}\n`;
			await Bun.write(file, body);
			for (const store of [new ClaudeSessionStore(dir.path()), new CodexSessionStore(dir.path())]) {
				await expect(store.load({ source: store.source, id: "foreign", path: file, cwd: dir.path(), created: new Date(timestamp), modified: new Date(timestamp) })).rejects.toThrow("Managed model-request journals cannot be imported");
			}
			expect(await Bun.file(file).text()).toBe(body);
		}
	});

	test("anonymized main and nested transcripts omit metadata and descriptor, not merely anonymize their ids", async () => {
		await using dir = await TempDir.create("@metadata-anon-");
		const { header, entries, metadata } = fixture(dir.path());
		const sessionFile = path.join(dir.path(), "main.jsonl");
		await Bun.write(sessionFile, jsonl(header, [...entries, metadata]));
		await Bun.write(path.join(dir.path(), "main/Child.jsonl"), jsonl(header, [...entries, metadata]));
		const result = await anonymizeSessionTranscripts({ header, entries: [...entries, metadata], sessionFile });
		expect(result.files).toHaveLength(2);
		const anonymizer = new SessionAnonymizer();
		expect(anonymizer.entry(metadata)).toBeUndefined();
		for (const [, body] of result.files) {
			expect(body.trim().split("\n")).toHaveLength(3);
			expect(body).not.toContain("modelRequestJournal");
			expect(body).not.toContain("model_request_metadata");
			expect(body).not.toContain(journalId);
			expect(body).not.toContain(journalOwnerId);
			expect(body).not.toContain(promptCanary);
			expect(body).not.toContain(keyCanary);
		}
	});

	test("File readers retain canonical rows and usage while HTML/share and nested leaves exclude journal bookkeeping", async () => {
		await using dir = await TempDir.create("@metadata-export-");
		const { header, entries, metadata } = fixture(dir.path());
		const file = path.join(dir.path(), "main.jsonl");
		await Bun.write(file, jsonl(header, [...entries, metadata]));
		await Bun.write(path.join(dir.path(), "main/Child.jsonl"), jsonl(header, [...entries, metadata]));
		const manager = await SessionManager.open(file, dir.path(), undefined, { suppressBreadcrumb: true });
		try {
			expect(manager.getEntries()).toEqual([...entries, metadata]);
			expect(manager.getLeafId()).toBe("asst0001");
			expect(manager.getBranch().map(entry => entry.id)).toEqual(["user0001", "asst0001"]);
			expect(manager.getTree().map(node => node.entry.id)).toEqual(["user0001"]);
			expect(manager.getUsageStatistics()).toMatchObject({ totalTokens: 12, cost: 0.03 });
			const replica = manager.snapshotForReplication();
			expect(replica.header.modelRequestJournal).toBeUndefined();
			expect(replica.entries).toEqual(entries);
			for (const projection of [buildSessionData(manager), buildShareSnapshot(manager)]) {
				expect(projection.entries).toEqual(entries);
				expect(projection.header?.modelRequestJournal).toBeUndefined();
			}
			expect(manager.getHeader()?.modelRequestJournal).toEqual(header.modelRequestJournal);
			const sub = (await collectSubSessions(file)).Child;
			expect(sub.entries).toEqual([...entries, metadata]);
			expect(sub.leafId).toBe("asst0001");
			const outputPath = path.join(dir.path(), "export.html");
			await exportFromFile(file, { outputPath });
			const html = await Bun.file(outputPath).text();
			const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
			if (!encoded) throw new Error("Expected embedded session data");
			const payload = Buffer.from(encoded, "base64").toString("utf8");
			expect(payload).not.toContain("modelRequestJournal");
			expect(payload).not.toContain("model_request_metadata");
			expect(payload).not.toContain(journalOwnerId);
			expect(payload.split(promptCanary)).toHaveLength(3);
			expect(payload.split(keyCanary)).toHaveLength(3);
		} finally {
			await manager.close();
		}
	});

	test("real context usage and stats parser retain old-journal totals without charging metadata", async () => {
		await using dir = await TempDir.create("@metadata-usage-");
		const { header, entries, metadata } = fixture(dir.path());
		const legacyHeader = { ...header };
		delete legacyHeader.modelRequestJournal;
		const oldFile = path.join(dir.path(), "old.jsonl");
		const managedFile = path.join(dir.path(), "managed.jsonl");
		await Bun.write(oldFile, jsonl(legacyHeader, entries));
		await Bun.write(managedFile, jsonl(header, [...entries, metadata]));
		const oldStats = await parseSessionFile(oldFile);
		const managedStats = await parseSessionFile(managedFile);
		expect(managedStats.stats.map(({ sessionFile: _file, ...stats }) => stats)).toEqual(
			oldStats.stats.map(({ sessionFile: _file, ...stats }) => stats),
		);
		expect(managedStats.stats).toHaveLength(1);
		const oldListing = await readSessionInfo(oldFile);
		const managedListing = await readSessionInfo(managedFile);
		if (!oldListing || !managedListing) throw new Error("Expected readable session listings");
		for (const listing of [oldListing, managedListing]) {
			expect(listing.messageCount).toBe(2);
			expect(listing.assistantTurns).toBe(1);
			expect(listing.firstMessage).toBe(promptCanary);
			expect(listing.status).toBe("complete");
			expect(listing.allMessagesText).not.toContain("model_request_metadata");
		}
		const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		const registry = new ModelRegistry(auth);
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Expected bundled model");
		const snapshots = [];
		try {
			for (const file of [oldFile, managedFile]) {
				const manager = await SessionManager.open(file, dir.path(), undefined, { suppressBreadcrumb: true });
				const agent = new Agent({ initialState: { model, systemPrompt: ["test"], tools: [], messages: manager.buildSessionContext().messages } });
				const session = new AgentSession({ agent, sessionManager: manager, modelRegistry: registry, settings: Settings.isolated({ "compaction.enabled": false }) });
				try {
					snapshots.push({ context: session.getContextUsage(), usage: manager.getUsageStatistics() });
				} finally {
					await session.dispose();
					await manager.close();
				}
			}
			expect(snapshots[0]?.context).toBeDefined();
			expect(snapshots[1]).toEqual(snapshots[0]);
		} finally {
			auth.close();
		}
	});

	test("tree metadata is hidden and unselectable even in all and labeled views", async () => {
		await initTheme(false, undefined, undefined, "dark", "light");
		const { entries, metadata } = fixture("/tmp");
		for (const mode of ["default", "all", "labeled-only"] as const) {
			const selected: string[] = [];
			const selector = new TreeSelectorComponent(
				[{ entry: entries[0], children: [], label: "conversation" }, { entry: metadata, children: [], label: "journal-canary" }],
				metadata.id, 40, id => selected.push(id), () => selected.push("cancelled"), undefined, mode,
			);
			expect(selector.render(100).join("\n")).not.toContain("journal-canary");
			selector.handleInput("\r");
			expect(selected).not.toContain(metadata.id);
		}
	});
});
