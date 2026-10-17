import { describe, expect, it } from "bun:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { ModelRequestJournalDescriptor,
	ModelRequestLifecycleRecord,
	ModelRequestMetadataEntry,
	ModelUsageEntry,
	ModelRequestSourceLinkInput,
	SessionEntry,
	SessionHeader,
	SessionMessageEntry, } from "@oh-my-pi/pi-utils/session-entries";
import { loadModelRequestJournalFromFile } from "../../src/session/session-loader";
import type { ModelRequestSourceInput } from "@oh-my-pi/pi-utils/session-entries";
import { SessionManager } from "../../src/session/session-manager";
import { FileSessionStorage } from "../../src/session/session-storage";

const timestamp = "2026-10-16T00:00:00.000Z";
const journalId = "11111111-1111-4111-8111-111111111111";
const journalOwnerId = "22222222-2222-4222-8222-222222222222";
const journalEpoch = "33333333-3333-4333-8333-333333333333";
const nextOwnerId = "44444444-4444-4444-8444-444444444444";
const nextEpoch = "55555555-5555-4555-8555-555555555555";
const promptCanary = "PROMPT_CANARY_JOURNAL_MANAGER";
const keyCanary = "KEY_CANARY_JOURNAL_MANAGER";
const rejectedCanary = "REJECTED_TYPED_APPEND_CANARY";

function assistantMessage(): AssistantMessage {
	return {
		role: "assistant", content: [{ type: "text", text: keyCanary }],
		api: "openai-completions", provider: "openai", model: "gpt-4o-mini", stopReason: "stop", timestamp: 2,
		usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
			cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } },
	};
}

interface JournalFixture {
	header: SessionHeader;
	descriptor: ModelRequestJournalDescriptor;
	sources: SessionEntry[];
	metadata: ModelRequestMetadataEntry[];
	assistantLink: ModelRequestMetadataEntry;
	usageLink: ModelRequestMetadataEntry;
	decision: ModelRequestMetadataEntry;
	user: SessionMessageEntry;
	assistant: SessionMessageEntry;
	usage: ModelUsageEntry;
	entries: SessionEntry[];
}

function fixture(cwd: string): JournalFixture {
	const descriptor: ModelRequestJournalDescriptor = {
		schemaVersion: 1, journalId, sessionId: "journal-session",
		epochs: [{ journalOwnerId, journalEpoch }, { journalOwnerId: nextOwnerId, journalEpoch: nextEpoch }],
	};
	const header: SessionHeader = { type: "session", version: 3, id: descriptor.sessionId, timestamp, cwd,
		modelRequestJournal: descriptor };
	const user: SessionMessageEntry = { type: "message", id: "user0001", parentId: null, timestamp,
		message: { role: "user", content: promptCanary, timestamp: 1 } };
	const assistant: SessionMessageEntry = { type: "message", id: "asst0001", parentId: user.id, timestamp,
		message: assistantMessage() };
	const usage: ModelUsageEntry = { type: "model_usage", id: "usage001", parentId: user.id, timestamp,
		purpose: "title", api: "openai-completions", provider: "openai", model: "gpt-4o-mini",
		usage: assistantMessage().usage, stopReason: "stop" };
	const assistantLink: ModelRequestMetadataEntry = {
		type: "model_request_metadata", id: "meta0001", parentId: null, timestamp, schemaVersion: 1,
		journalId, sessionId: header.id, journalOwnerId, journalEpoch, seq: 1,
		record: { schemaVersion: 1, sourceKind: "assistant", sourceSessionId: header.id, sourceEntryId: assistant.id,
			resultId: null, provenance: { kind: "non-wire", reason: "cache" } },
	};
	const usageLink: ModelRequestMetadataEntry = {
		...assistantLink, id: "meta0002", seq: 2,
		record: { schemaVersion: 1, sourceKind: "model_usage", sourceSessionId: header.id, sourceEntryId: usage.id,
			resultId: null, provenance: { kind: "non-wire", reason: "local" } },
	};
	const decision: ModelRequestMetadataEntry = {
		...assistantLink, id: "meta0003", journalOwnerId: nextOwnerId, journalEpoch: nextEpoch, seq: 1,
		record: { schemaVersion: 1, event: "decision", requestId: "66666666-6666-4666-8666-666666666666",
			coreAttemptId: "77777777-7777-4777-8777-777777777777", coreRetryOf: null,
			rootSessionId: header.id, sessionId: header.id, purpose: "main",
			modelRef: { provider: "openai", id: "gpt-4o-mini", api: "openai-completions" }, atMs: 0, decision: "pass" },
	};
	const sources: SessionEntry[] = [user, usage, assistant];
	const metadata = [assistantLink, usageLink, decision];
	return { header, descriptor, sources, metadata, assistantLink, usageLink, decision, user, assistant, usage,
		entries: [...sources, ...metadata] };
}

function jsonl(records: readonly unknown[]): string {
	return `${records.map(record => JSON.stringify(record)).join("\n")}\n`;
}

async function open(file: string, storage = new FileSessionStorage()): Promise<SessionManager> {
	return SessionManager.open(file, path.dirname(file), storage, { suppressBreadcrumb: true, throwIfMissing: true });
}

function journalInputs(manager: SessionManager) {
	const record: ModelRequestLifecycleRecord = {
		schemaVersion: 1, event: "decision", requestId: "66666666-6666-4666-8666-666666666666",
		coreAttemptId: "77777777-7777-4777-8777-777777777777", coreRetryOf: null,
		rootSessionId: manager.getSessionId(), sessionId: manager.getSessionId(), purpose: "main",
		modelRef: { provider: "openai", id: "gpt-4o-mini", api: "openai-completions" }, atMs: 0, decision: "pass",
	};
	const message = assistantMessage();
	message.content = [{ type: "text", text: rejectedCanary }];
	const assistant: ModelRequestSourceInput = { kind: "assistant", args: [message] };
	const usage: ModelRequestSourceInput = {
		kind: "model_usage",
		args: [{ purpose: "title", api: message.api, provider: message.provider, model: message.model,
			usage: message.usage, stopReason: message.stopReason },
			{ sessionId: manager.getSessionId(), parentId: manager.getLeafId() }],
	};
	const assistantLink: ModelRequestSourceLinkInput = {
		schemaVersion: 1, sourceKind: "assistant", resultId: null, provenance: { kind: "non-wire", reason: "cache" },
	};
	const usageLink: ModelRequestSourceLinkInput = {
		schemaVersion: 1, sourceKind: "model_usage", resultId: null, provenance: { kind: "non-wire", reason: "local" },
	};
	return { record, assistant, usage, assistantLink, usageLink };
}

async function expectRejectedWithoutMutation(manager: SessionManager, operation: () => unknown): Promise<void> {
	const entries = JSON.stringify(manager.getEntries());
	const header = JSON.stringify(manager.getHeader());
	const leaf = manager.getLeafId();
	const file = manager.getSessionFile();
	const bytes = file ? await readFile(file, "utf8") : undefined;
	await expect(Promise.resolve().then(operation)).rejects.toThrow();
	expect(JSON.stringify(manager.getEntries())).toBe(entries);
	expect(JSON.stringify(manager.getHeader())).toBe(header);
	expect(manager.getLeafId()).toBe(leaf);
	await manager.flush();
	expect(JSON.stringify(manager.getEntries())).not.toContain(rejectedCanary);
	if (file) {
		if (bytes === undefined) throw new Error("Missing original File snapshot.");
		expect(await readFile(file, "utf8")).toBe(bytes);
		expect(await readFile(file, "utf8")).not.toContain(rejectedCanary);
	}
}

type JournalBackend = "File" | "inMemory";

async function withJournalBackend(
	backend: JournalBackend,
	run: (manager: SessionManager, data: JournalFixture) => Promise<void>,
): Promise<void> {
	await using dir = await TempDir.create("@journal-typed-reject-");
	const data = fixture(dir.path());
	const file = path.join(dir.path(), "managed.jsonl");
	if (backend === "File") await writeFile(file, jsonl([data.header, ...data.entries]));
	const manager = backend === "File" ? await open(file) : SessionManager.inMemory(dir.path());
	if (backend === "inMemory") manager.appendMessage({ role: "user", content: "existing branch", timestamp: 1 });
	try {
		await run(manager, data);
		if (backend === "File") {
			// A separate File reader, not a cloned manager, observes the durable prefix.
			const reader = await open(file);
			try {
				expect(reader.getHeader()?.modelRequestJournal).toEqual(data.descriptor);
				expect(reader.getEntries()).toEqual(data.entries);
				expect(reader.getLeafId()).toBe(data.assistant.id);
				expect((await loadModelRequestJournalFromFile(file)).metadataEntries).toEqual(data.metadata);
			} finally { await reader.close(); }
		}
	} finally { await manager.close(); }
}

describe("model-request typed append rejects unissued capabilities", () => {
	for (const backend of ["File", "inMemory"] as const) {
		it(`rejects forged and copied owner DTOs without metadata, source or leaf mutation in ${backend}`, async () => {
			await withJournalBackend(backend, async (manager, data) => {
				const input = journalInputs(manager);
				// Every candidate is unissued. Copying persisted identifiers never creates an owner.
				const owners: readonly unknown[] = [
					undefined, null, {}, data.descriptor, structuredClone(data.descriptor),
					data.descriptor.epochs[0], { ...data.descriptor.epochs[0] },
					Object.freeze({ schemaVersion: 1, journalId, sessionId: manager.getSessionId(),
						journalOwnerId, journalEpoch }),
				];
				for (const owner of owners) {
					await expectRejectedWithoutMutation(manager,
						() => Reflect.apply(manager.appendModelRequestMetadata, manager, [owner, input.record]));
					await expectRejectedWithoutMutation(manager,
						() => Reflect.apply(manager.appendModelRequestSource, manager, [owner, input.assistant, input.assistantLink]));
					await expectRejectedWithoutMutation(manager,
						() => Reflect.apply(manager.appendModelRequestSource, manager, [owner, input.usage, input.usageLink]));
				}
			});
		});

		it(`does not persist malformed or canary payloads supplied without an issued owner in ${backend}`, async () => {
			await withJournalBackend(backend, async (manager, data) => {
				const input = journalInputs(manager);
				const unissuedOwner = { journalId, sessionId: manager.getSessionId(), journalOwnerId, journalEpoch };
				const records: readonly unknown[] = [
					null, {}, data.assistantLink,
					{ ...input.record, body: rejectedCanary },
					{ ...input.record, headers: { authorization: rejectedCanary } },
					{ ...input.record, modelRef: { ...input.record.modelRef, baseUrl: rejectedCanary } },
					{ ...input.record, atMs: -1 },
					{ ...input.record, sessionId: "foreign-session" },
				];
				for (const record of records) {
					await expectRejectedWithoutMutation(manager,
						() => Reflect.apply(manager.appendModelRequestMetadata, manager, [unissuedOwner, record]));
				}
				const links: readonly unknown[] = [
					null, {}, data.assistantLink.record,
					{ ...input.assistantLink, body: rejectedCanary },
					{ ...input.assistantLink, provenance: { kind: "unresolved", error: rejectedCanary } },
					{ ...input.assistantLink, provenance: { kind: "non-wire", reason: "unknown" } },
					{ ...input.assistantLink, sourceKind: "model_usage" },
				];
				for (const link of links) {
					await expectRejectedWithoutMutation(manager,
						() => Reflect.apply(manager.appendModelRequestSource, manager, [unissuedOwner, input.assistant, link]));
				}
				const sources: readonly unknown[] = [
					null, {}, { kind: "assistant", args: [] },
					{ kind: "assistant", args: [{ role: "user", content: rejectedCanary, timestamp: 2 }] },
					{ kind: "model_usage", args: input.usage.args },
					{ kind: "unknown", args: [rejectedCanary] },
				];
				for (const source of sources) {
					await expectRejectedWithoutMutation(manager,
						() => Reflect.apply(manager.appendModelRequestSource, manager, [unissuedOwner, source, input.assistantLink]));
				}
			});
		});
	}

	it("does not turn a reopened readonly descriptor or epoch into a write capability", async () => {
		await using dir = await TempDir.create("@journal-reopened-owner-");
		const data = fixture(dir.path());
		const file = path.join(dir.path(), "managed.jsonl");
		const body = jsonl([data.header, ...data.entries]);
		await writeFile(file, body);
		const original = await open(file);
		const originalDescriptor = original.getHeader()?.modelRequestJournal;
		await original.close();
		const manager = await open(file);
		try {
			const loaded = await loadModelRequestJournalFromFile(file);
			const descriptor = manager.getHeader()?.modelRequestJournal;
			if (!descriptor) throw new Error("Missing persisted fixture descriptor");
			const input = journalInputs(manager);
			const owners: readonly unknown[] = [
				originalDescriptor, descriptor, descriptor.epochs.at(-1),
				loaded.descriptor, loaded.descriptor.epochs.at(-1), structuredClone(loaded.descriptor),
			];
			for (const owner of owners) {
				await expectRejectedWithoutMutation(manager,
					() => Reflect.apply(manager.appendModelRequestMetadata, manager, [owner, input.record]));
				await expectRejectedWithoutMutation(manager,
					() => Reflect.apply(manager.appendModelRequestSource, manager, [owner, input.assistant, input.assistantLink]));
				await expectRejectedWithoutMutation(manager,
					() => Reflect.apply(manager.appendModelRequestSource, manager, [owner, input.usage, input.usageLink]));
			}
			expect(await readFile(file, "utf8")).toBe(body);
			expect((await loadModelRequestJournalFromFile(file)).metadataEntries).toEqual(data.metadata);
		} finally { await manager.close(); }
	});
});

// These are persisted reader fixtures, not issued owners or evidence of append acknowledgements.
describe("model-request journal real File manager", () => {
	it("retains canonical metadata while branch, tree, leaf, context and usage match the legacy file", async () => {
		await using dir = await TempDir.create("@journal-manager-");
		const data = fixture(dir.path());
		const file = path.join(dir.path(), "managed.jsonl");
		const legacyFile = path.join(dir.path(), "legacy.jsonl");
		const { modelRequestJournal: _descriptor, ...legacyHeader } = data.header;
		await writeFile(file, jsonl([data.header, ...data.entries]));
		await writeFile(legacyFile, jsonl([legacyHeader, ...data.sources]));
		const managed = await open(file);
		const legacy = await open(legacyFile);
		try {
			expect(managed.getEntries()).toEqual(data.entries);
			expect(managed.getHeader()?.modelRequestJournal).toEqual(data.descriptor);
			for (const metadata of data.metadata) {
				expect(managed.getEntry(metadata.id)).toEqual(metadata);
				expect(managed.getBranch(metadata.id)).toEqual([]);
				expect(managed.getChildren(metadata.id)).toEqual([]);
				expect(() => managed.branch(metadata.id)).toThrow();
				expect(() => managed.appendLabelChange(metadata.id, "metadata")).toThrow();
				expect(() => managed.ingestReplicatedEntry(metadata)).toThrow();
				expect(() => legacy.ingestReplicatedEntry(metadata)).toThrow();
			}
			expect(legacy.getEntries()).toEqual(data.sources);
			expect(managed.getLeafId()).toBe(data.assistant.id);
			expect(managed.getLeafEntry()).toEqual(legacy.getLeafEntry());
			expect(managed.getBranch()).toEqual(legacy.getBranch());
			expect(managed.getBranchView()).toEqual(legacy.getBranchView());
			expect(managed.getTree()).toEqual(legacy.getTree());
			expect(managed.buildSessionContext()).toEqual(legacy.buildSessionContext());
			expect(managed.buildSessionContext({ transcript: true })).toEqual(legacy.buildSessionContext({ transcript: true }));
			expect(managed.getUsageStatistics()).toEqual(legacy.getUsageStatistics());
			expect(managed.snapshotForReplication()).toEqual({ header: legacyHeader, entries: data.sources });
			const metadataJson = JSON.stringify([data.descriptor, ...data.metadata]);
			expect(metadataJson).not.toContain(promptCanary);
			expect(metadataJson).not.toContain(keyCanary);
			const validated = await loadModelRequestJournalFromFile(file);
			expect([...validated.throughSeqByEpoch]).toEqual([[journalEpoch, 2], [nextEpoch, 1]]);
			expect(await readFile(file, "utf8")).toBe(jsonl([data.header, ...data.entries]));
		} finally {
			await Promise.all([managed.close(), legacy.close()]);
		}
	});

	it("preserves exact descriptor, all epochs, metadata and source IDs through rewrite and capture/restore", async () => {
		await using dir = await TempDir.create("@journal-preserve-");
		const data = fixture(dir.path());
		const file = path.join(dir.path(), "managed.jsonl");
		await writeFile(file, jsonl([data.header, ...data.entries]));
		const manager = await open(file);
		try {
			await manager.rewriteEntries();
			const snapshot = manager.captureState();
			manager.restoreState(snapshot);
			await manager.rewriteEntries();
			const reader = await open(file);
			try {
				expect(reader.getEntries()).toEqual(data.entries);
				expect(reader.getHeader()?.modelRequestJournal).toEqual(data.descriptor);
				expect(reader.getLeafId()).toBe(data.assistant.id);
				expect((await loadModelRequestJournalFromFile(file)).metadataEntries).toEqual(data.metadata);
			} finally { await reader.close(); }
			const bytes = await readFile(file, "utf8");
			const { modelRequestJournal: _descriptor, ...strippedHeader } = snapshot.header;
			const rejected = [
				structuredClone(snapshot),
				{ ...snapshot, cwd: path.join(dir.path(), "relocated") },
				{ ...snapshot, sessionDir: path.join(dir.path(), "other") },
				{ ...snapshot, sessionFile: path.join(dir.path(), "other.jsonl") },
				{ ...snapshot, sessionId: "other-session" },
				{ ...snapshot, header: strippedHeader },
				{ ...snapshot, header: { ...snapshot.header, modelRequestJournal: { ...data.descriptor,
					epochs: [{ journalOwnerId, journalEpoch }] } } },
				{ ...snapshot, entries: data.sources },
				{ ...snapshot, entries: data.entries.filter(entry => entry.id !== data.assistant.id) },
				{ ...snapshot, entries: data.entries.map(entry => entry.id === data.assistant.id ? { ...entry, id: "changed1" } : entry) },
				{ ...snapshot, entries: data.entries.map(entry => entry.id === data.decision.id ? { ...data.decision, seq: 2 } : entry) },
			];
			for (const invalid of rejected) {
				expect(() => manager.restoreState(invalid)).toThrow();
				expect(manager.getEntries()).toEqual(data.entries);
				expect(await readFile(file, "utf8")).toBe(bytes);
			}
			const mutations: ((state: typeof snapshot) => void)[] = [
				state => { delete state.header.modelRequestJournal; },
				state => { state.header.modelRequestJournal = { ...data.descriptor, epochs: [{ journalOwnerId, journalEpoch }] }; },
				state => { state.entries = data.sources; },
				state => { state.entries = data.entries.filter(entry => entry.id !== data.assistant.id); },
				state => { state.entries = data.entries.map(entry => entry.id === data.decision.id ? { ...data.decision, seq: 2 } : entry); },
				state => { state.entries = data.entries.map(entry => entry.id === data.assistant.id ? { ...entry, id: "changed1" } : entry); },
				state => { state.cwd = path.join(dir.path(), "relocated"); },
				state => { state.sessionFile = path.join(dir.path(), "other.jsonl"); },
			];
			for (const mutate of mutations) {
				const ownedSnapshot = manager.captureState();
				mutate(ownedSnapshot);
				expect(() => manager.restoreState(ownedSnapshot)).toThrow();
				expect(manager.getEntries()).toEqual(data.entries);
				expect(await readFile(file, "utf8")).toBe(bytes);
			}
			const foreign = await open(file);
			try { expect(() => foreign.restoreState(snapshot)).toThrow(); }
			finally { await foreign.close(); }
		} finally { await manager.close(); }
	});

	it("refuses destructive managed operations before changing any session file", async () => {
		await using dir = await TempDir.create("@journal-refuse-");
		const data = fixture(dir.path());
		const file = path.join(dir.path(), "managed.jsonl");
		const body = jsonl([data.header, ...data.entries]);
		await writeFile(file, body);
		const manager = await open(file);
		try {
			const before = (await readdir(dir.path())).sort();
			const sync = [() => manager.cloneCurrentSession(), () => manager.cloneCurrentSession({ persist: false }),
				() => manager.createBranchedSession(data.assistant.id)];
			const asyncOperations = [
				() => manager.fork(),
				() => SessionManager.forkFrom(file, dir.path(), dir.path(), undefined, { suppressBreadcrumb: true }),
				() => manager.persistCopy({ sessionDir: dir.path(), suppressBreadcrumb: true }),
				() => manager.moveTo(path.join(dir.path(), "moved"), path.join(dir.path(), "target")),
				() => manager.dropSession(file), () => manager.discardEntryDurably(data.assistant.id),
			];
			for (const operation of sync) expect(operation).toThrow();
			for (const operation of asyncOperations) await expect(operation()).rejects.toThrow();
			expect(await readFile(file, "utf8")).toBe(body);
			expect((await readdir(dir.path())).sort()).toEqual(before);
			expect(manager.getEntries()).toEqual(data.entries);
			expect(manager.getSessionFile()).toBe(file);
		} finally { await manager.close(); }
	});

	it("refuses an in-place destructive header rewrite without touching the old full file", async () => {
		await using dir = await TempDir.create("@journal-rewrite-refuse-");
		const data = fixture(dir.path());
		const file = path.join(dir.path(), "managed.jsonl");
		const body = jsonl([data.header, ...data.entries]);
		await writeFile(file, body);
		const manager = await open(file);
		const header = manager.getHeader();
		if (!header) throw new Error("Missing fixture header");
		try {
			delete header.modelRequestJournal;
			await expect(manager.rewriteEntries()).rejects.toThrow();
			expect(await readFile(file, "utf8")).toBe(body);
		} finally {
			header.modelRequestJournal = data.descriptor;
			await manager.close().catch(() => {});
		}
	});

	const corruptions: { name: string; records: (data: JournalFixture) => unknown[] }[] = [
		{ name: "missing descriptor", records: data => { const { modelRequestJournal: _descriptor, ...header } = data.header;
			return [header, ...data.entries]; } },
		{ name: "header session mismatch", records: data => [{ ...data.header,
			modelRequestJournal: { ...data.descriptor, sessionId: "other-session" } }, ...data.entries] },
		{ name: "seq gap", records: data => [data.header, ...data.sources, { ...data.assistantLink, seq: 2 }, data.usageLink, data.decision] },
		{ name: "duplicate seq", records: data => [data.header, ...data.sources, data.assistantLink, { ...data.usageLink, seq: 1 }, data.decision] },
		{ name: "epoch rollback", records: data => [data.header, ...data.sources, data.decision, data.assistantLink, data.usageLink] },
		{ name: "foreign owner", records: data => [data.header, ...data.sources, { ...data.assistantLink, journalOwnerId: nextOwnerId }] },
		{ name: "missing source", records: data => [data.header, ...data.sources.filter(entry => entry.id !== data.assistant.id), ...data.metadata] },
		{ name: "wrong source kind", records: data => [data.header, ...data.sources, { ...data.assistantLink,
			record: { schemaVersion: 1, sourceKind: "assistant", sourceSessionId: data.header.id, sourceEntryId: data.usage.id,
				resultId: null, provenance: { kind: "non-wire", reason: "cache" } } }] },
		{ name: "source after link", records: data => [data.header, data.user, data.usage, data.assistantLink, data.assistant] },
		{ name: "secret extra field", records: data => [data.header, ...data.sources, { ...data.assistantLink, credential: keyCanary }] },
	];
	for (const corruption of corruptions) {
		it(`fails closed on ${corruption.name} in the actual file`, async () => {
			await using dir = await TempDir.create("@journal-invalid-");
			const file = path.join(dir.path(), "managed.jsonl");
			const body = jsonl(corruption.records(fixture(dir.path())));
			await writeFile(file, body);
			await expect(open(file)).rejects.toThrow();
			await expect(loadModelRequestJournalFromFile(file)).rejects.toThrow("Invalid model request journal");
			expect(await readFile(file, "utf8")).toBe(body);
		});
	}

	it("never advances a managed prefix by skipping a malformed or truncated physical line", async () => {
		await using dir = await TempDir.create("@journal-malformed-");
		const data = fixture(dir.path());
		const file = path.join(dir.path(), "managed.jsonl");
		for (const tail of ["{broken-json}\\n", "{\"type\":\"model_request_metadata\""]) {
			const body = jsonl([data.header, ...data.entries]) + tail;
			await writeFile(file, body);
			await expect(open(file)).rejects.toThrow();
			await expect(loadModelRequestJournalFromFile(file)).rejects.toThrow("Invalid model request journal");
			expect(await readFile(file, "utf8")).toBe(body);
		}
	});

	for (const code of ["EIO", "EPERM"]) {
		it(`keeps the old full File journal when staged native replacement fails with ${code}`, async () => {
			await using dir = await TempDir.create("@journal-file-fault-");
			const data = fixture(dir.path());
			const file = path.join(dir.path(), "managed.jsonl");
			const body = jsonl([data.header, ...data.entries]);
			await writeFile(file, body);
			class FailedPublishStorage extends FileSessionStorage {
				staged = false;
				publishAttempts = 0;
				override renameSync(source: string, target: string): void {
					if (target === file && source.endsWith(".tmp")) {
						this.staged = this.existsSync(source);
						this.publishAttempts++;
						throw Object.assign(new Error("injected File publish failure"), { code });
					}
					super.renameSync(source, target);
				}
			}
			const storage = new FailedPublishStorage();
			const manager = await open(file, storage);
			const failures: Error[] = [];
			const unsubscribe = manager.onPersistenceError(error => failures.push(error));
			try {
				await expect(manager.rewriteEntries()).rejects.toThrow("injected File publish failure");
				expect(storage.staged).toBe(true);
				expect(storage.publishAttempts).toBe(1);
				expect(failures.length).toBeGreaterThan(0);
				expect(await readFile(file, "utf8")).toBe(body);
				expect((await readdir(dir.path())).some(name => name.endsWith(".tmp") || name.endsWith(".bak"))).toBe(false);
				const reader = await open(file);
				try {
					expect(reader.getEntries()).toEqual(data.entries);
					expect((await loadModelRequestJournalFromFile(file)).metadataEntries).toEqual(data.metadata);
				} finally { await reader.close(); }
			} finally {
				unsubscribe();
				await manager.close().catch(() => {});
			}
		});
	}

	it("switches to an ordinary new session without copying or changing managed history", async () => {
		await using dir = await TempDir.create("@journal-switch-");
		const data = fixture(dir.path());
		const file = path.join(dir.path(), "managed.jsonl");
		const body = jsonl([data.header, ...data.entries]);
		await writeFile(file, body);
		const manager = await open(file);
		try {
			await manager.newSession({ sessionDir: dir.path() });
			expect(manager.getSessionId()).not.toBe(data.header.id);
			expect(manager.getHeader()?.modelRequestJournal).toBeUndefined();
			expect(manager.getEntries()).toEqual([]);
			manager.appendMessage(assistantMessage());
			await manager.flush();
			expect(await readFile(file, "utf8")).toBe(body);
			expect((await loadModelRequestJournalFromFile(file)).metadataEntries).toEqual(data.metadata);
		} finally { await manager.close(); }
	});

	it("preserves ordinary legacy append, usage, branch, rewrite, clone, copy, fork, move and discard APIs", async () => {
		await using dir = await TempDir.create("@journal-legacy-");
		const file = path.join(dir.path(), "legacy.jsonl");
		const data = fixture(dir.path());
		const { modelRequestJournal: _descriptor, ...header } = data.header;
		await writeFile(file, jsonl([header, ...data.sources]));
		const manager = await open(file);
		const opened: SessionManager[] = [manager];
		try {
			const id = manager.appendMessage({ role: "user", content: "legacy", timestamp: 3 });
			expect(typeof id).toBe("string");
			const usageId = manager.appendModelUsage(data.usage, { sessionId: manager.getSessionId(), parentId: id });
			expect(typeof usageId).toBe("string");
			manager.branch(id);
			expect(manager.getLeafId()).toBe(id);
			await manager.flush();
			await manager.rewriteEntries();
			const clone = manager.cloneCurrentSession({ persist: false });
			opened.push(clone);
			expect(clone.getEntries()).toEqual(manager.getEntries());
			const copy = await manager.persistCopy({ sessionDir: dir.path(), suppressBreadcrumb: true });
			opened.push(copy);
			expect(copy.getSessionId()).not.toBe(manager.getSessionId());
			const fork = await SessionManager.forkFrom(file, dir.path(), dir.path(), undefined, { suppressBreadcrumb: true, copyArtifacts: false });
			opened.push(fork);
			expect(fork.getHeader()?.modelRequestJournal).toBeUndefined();
			expect(await manager.fork()).toBeDefined();
			expect(manager.createBranchedSession(id, { copyArtifacts: false })).toBeDefined();
			await manager.moveTo(dir.path(), path.join(dir.path(), "moved"));
			await manager.discardEntryDurably(id);
			const current = manager.getSessionFile();
			if (!current) throw new Error("Missing legacy session file");
			await manager.dropSession(current);
			expect(manager.getHeader()?.modelRequestJournal).toBeUndefined();
		} finally { await Promise.all(opened.map(session => session.close())); }
	});
});
