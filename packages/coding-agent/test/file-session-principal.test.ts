import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	loadModelRequestJournalFromFile,
	loadSessionFile,
} from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	appendJournalMetadata,
	assertJournalExecutionIdentity,
	composeJournalSession,
	createJournalExecution,
	type FileJournalCell,
	FileSessionStorage,
	openFileJournalCell,
	SessionWriteConflictError,
} from "@oh-my-pi/pi-utils/model-request-journal-composition";
import type {
	FileEntry,
	ModelRequestLifecycleRecord,
	ModelRequestMetadataEntry,
	SessionEntry,
	SessionHeader,
	SessionMessageEntry,
} from "@oh-my-pi/pi-utils/session-entries";
import { loadEntriesFromFileStream } from "@oh-my-pi/pi-utils/session-file-reader";
import { serializeTitleSlot } from "@oh-my-pi/pi-utils/session-title-slot";

const ISO = "2026-10-16T00:00:00.000Z";
const UPDATED_ISO = "2026-10-17T00:00:00.000Z";
const JOURNAL = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const EPOCH = "33333333-3333-4333-8333-333333333333";
const ATTEMPT = "44444444-4444-4444-8444-444444444444";
const REQUEST = "55555555-5555-4555-8555-555555555555";
const unavailable = /Model request journal capability is unavailable/;

function ordinaryHeader(cwd: string): SessionHeader {
	return { type: "session", version: 3, id: crypto.randomUUID(), timestamp: ISO, cwd };
}

function userEntry(id: string, parentId: string | null = null): SessionMessageEntry {
	return {
		type: "message", id, parentId, timestamp: ISO,
		message: { role: "user", content: `message ${id}`, timestamp: 1 },
	};
}

async function persist(file: string, entries: readonly FileEntry[]): Promise<string> {
	const bytes = `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`;
	await Bun.write(file, bytes);
	return bytes;
}

async function closeCell(cell: FileJournalCell): Promise<void> {
	try {
		await cell.close();
	} finally {
		cell.releaseRetainedEntries();
	}
}

interface ManagedFixture {
	header: SessionHeader;
	decision: ModelRequestLifecycleRecord;
	metadata: ModelRequestMetadataEntry;
	assistant: SessionMessageEntry;
	linked: ModelRequestMetadataEntry;
}

function managedFixture(cwd: string): ManagedFixture {
	// Persisted-reader fixtures, matching model-request-journal-reader.test.ts;
	// these bytes neither issue an owner nor register a ready execution.
	const sessionId = crypto.randomUUID();
	const header: SessionHeader = {
		type: "session", version: 3, id: sessionId, timestamp: ISO, cwd,
		modelRequestJournal: {
			schemaVersion: 1, journalId: JOURNAL, sessionId,
			epochs: [{ journalOwnerId: OWNER, journalEpoch: EPOCH }],
		},
	};
	const decision: ModelRequestLifecycleRecord = {
		schemaVersion: 1, event: "decision", coreAttemptId: ATTEMPT, requestId: REQUEST, coreRetryOf: null,
		rootSessionId: sessionId, sessionId, purpose: "main",
		modelRef: { provider: "openai", id: "gpt-5", api: "openai-responses" },
		atMs: 1, decision: "pass",
	};
	const metadata: ModelRequestMetadataEntry = {
		type: "model_request_metadata", id: "metadata1", parentId: null, timestamp: ISO,
		schemaVersion: 1, journalId: JOURNAL, sessionId, journalOwnerId: OWNER, journalEpoch: EPOCH,
		seq: 1, record: decision,
	};
	const assistant: SessionMessageEntry = {
		type: "message", id: "assistant1", parentId: null, timestamp: ISO,
		message: {
			role: "assistant", api: "openai-responses", provider: "openai", model: "gpt-5",
			stopReason: "stop", timestamp: 1, content: [{ type: "text", text: "reader fixture" }],
			usage: {
				input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	};
	const linked: ModelRequestMetadataEntry = {
		...metadata, id: "metadata2", seq: 2,
		record: {
			schemaVersion: 1, sourceKind: "assistant", sourceSessionId: sessionId,
			sourceEntryId: assistant.id, resultId: null, provenance: { kind: "non-wire", reason: "cache" },
		},
	};
	return { header, decision, metadata, assistant, linked };
}

function managedEntries(fixture: ManagedFixture): FileEntry[] {
	return [fixture.header, fixture.metadata, fixture.assistant, fixture.linked];
}

describe("actual File session principal", () => {
	it("loads a malformed ordinary legacy tail leniently, migrates in memory, and preserves bytes until a rewrite", async () => {
		using dir = TempDir.createSync("@file-principal-legacy-");
		const file = path.join(dir.path(), "session.jsonl");
		const header = { ...ordinaryHeader(dir.path()), version: 1 };
		const bytes = `${JSON.stringify(header)}\n${JSON.stringify({
			type: "message", timestamp: ISO, message: { role: "user", content: "legacy", timestamp: 1 },
		})}\n{BROKEN`;
		await Bun.write(file, bytes);
		const ordinary = await loadSessionFile(file);
		expect(ordinary.malformedRecords).toBe(1);
		expect(ordinary.entries[0]).toMatchObject({ version: 1 });
		const cell = openFileJournalCell({ cwd: dir.path(), sessionFile: file });
		try {
			expect(cell.getHeader()).toMatchObject({ id: header.id, version: 3 });
			const migrated = cell.getEntries();
			expect(migrated).toHaveLength(1);
			expect(migrated[0]).toMatchObject({ type: "message", parentId: null, message: { content: "legacy" } });
			expect(migrated[0]?.id).toEqual(expect.any(String));
			expect(cell.getExpectedDiskSize()).toBe(Buffer.byteLength(bytes));
			expect(await Bun.file(file).text()).toBe(bytes);
			const continuation = userEntry("continuation", cell.getLeafId());
			cell.appendEntry(continuation);
			expect(cell.getEntry(continuation.id)).toEqual(continuation);
			expect(await Bun.file(file).text()).toBe(bytes);
			expect(cell.getExpectedDiskSize()).toBe(Buffer.byteLength(bytes));
			await cell.ensureOnDisk();
			const reread = await loadSessionFile(file);
			expect(reread.malformedRecords).toBe(0);
			expect(reread.invalidHeader).toBe(false);
			expect(reread.entries).toEqual([cell.getHeader(), ...cell.getEntries()]);
			expect(cell.getExpectedDiskSize()).toBe(Buffer.byteLength(await Bun.file(file).text()));
			expect(await Bun.file(file).text()).not.toContain("{BROKEN");
			// Opening/migrating did not mutate the independently loaded snapshot.
			expect(ordinary.entries[0]).toMatchObject({ version: 1 });
		} finally {
			await closeCell(cell);
		}
	});

	it.each(["{BROKEN\n", `${JSON.stringify(userEntry("not-a-header"))}\n`])(
		"rejects a corrupt ordinary header without replacing its bytes: %s",
		async bytes => {
			using dir = TempDir.createSync("@file-principal-header-");
			const file = path.join(dir.path(), "session.jsonl");
			await Bun.write(file, bytes);
			expect(() => openFileJournalCell({ cwd: dir.path(), sessionFile: file })).toThrow();
			expect(await Bun.file(file).text()).toBe(bytes);
		},
	);

	it("canonicalizes a symlinked parent before finding the existing cell", async () => {
		using dir = TempDir.createSync("@file-principal-alias-");
		const realDir = path.join(dir.path(), "sessions");
		const aliasDir = path.join(dir.path(), "alias");
		fs.mkdirSync(realDir);
		fs.symlinkSync(realDir, aliasDir, "dir");
		const file = path.join(realDir, "session.jsonl");
		await persist(file, [ordinaryHeader(dir.path()), userEntry("first")]);
		const cell = openFileJournalCell({ cwd: dir.path(), sessionDir: realDir, sessionFile: file });
		try {
			const alias = path.join(aliasDir, "session.jsonl");
			expect(openFileJournalCell({ cwd: dir.path(), sessionDir: aliasDir, sessionFile: alias })).toBe(cell);
			expect(cell.getSessionFile()).toBe(fs.realpathSync(file));
			expect(cell.getSessionDir()).toBe(fs.realpathSync(realDir));
			const writer = cell.openWriter(file);
			expect(new FileSessionStorage().openWriter(alias)).toBe(writer);
			expect(new FileSessionStorage().openWriter(file)).toBe(writer);
		} finally {
			await closeCell(cell);
		}
	});

	it("adopts a pre-principal raw writer and shares that sole writer across later storage instances", async () => {
		using dir = TempDir.createSync("@file-principal-writer-");
		const file = path.join(dir.path(), "session.jsonl");
		await persist(file, [ordinaryHeader(dir.path())]);
		const storage = new FileSessionStorage();
		const oldWriter = storage.openWriter(file);
		expect(new FileSessionStorage().openWriter(file)).toBe(oldWriter);
		const cell = openFileJournalCell({ cwd: dir.path(), sessionFile: file });
		try {
			expect(cell.openWriter(file)).toBe(oldWriter);
			expect(storage.openWriter(file)).toBe(oldWriter);
			expect(new FileSessionStorage().openWriter(file)).toBe(oldWriter);
			const entry = userEntry("raw-continuation");
			await oldWriter.append(`${JSON.stringify(entry)}\n`);
			expect(cell.getEntry(entry.id)).toEqual(entry);
			expect((await loadSessionFile(file)).entries).toEqual([cell.getHeader(), entry]);
		} finally {
			await closeCell(cell);
			await oldWriter.close();
		}
	});

	it("closes a pre-principal hard-link writer instead of retaining a second append descriptor", async () => {
		using dir = TempDir.createSync("@file-principal-hardlink-");
		const file = path.join(dir.path(), "session.jsonl");
		const alias = path.join(dir.path(), "hardlink.jsonl");
		await persist(file, [ordinaryHeader(dir.path())]);
		fs.linkSync(file, alias);
		const oldWriter = new FileSessionStorage().openWriter(alias);
		const cell = openFileJournalCell({ cwd: dir.path(), sessionFile: file });
		try {
			const writer = cell.openWriter(file);
			expect(oldWriter.isOpen()).toBe(false);
			expect(writer).not.toBe(oldWriter);
			expect(new FileSessionStorage().openWriter(alias)).toBe(writer);
			expect(new FileSessionStorage().openWriter(file)).toBe(writer);
			const bytes = await Bun.file(file).text();
			await expect(oldWriter.append(`${JSON.stringify(userEntry("stale"))}\n`)).rejects.toThrow();
			expect(await Bun.file(file).text()).toBe(bytes);
		} finally {
			await closeCell(cell);
			await oldWriter.close();
		}
	});

	it("uses sessionId only as an exact existing identity check, never a new-session override", async () => {
		using dir = TempDir.createSync("@file-principal-id-");
		const file = path.join(dir.path(), "session.jsonl");
		const missing = path.join(dir.path(), "missing.jsonl");
		const duplicate = path.join(dir.path(), "duplicate.jsonl");
		const header = ordinaryHeader(dir.path());
		const bytes = await persist(file, [header]);
		const cell = openFileJournalCell({ cwd: dir.path(), sessionFile: file, sessionId: header.id });
		try {
			expect(openFileJournalCell({ cwd: dir.path(), sessionFile: file, sessionId: header.id })).toBe(cell);
			expect(() => openFileJournalCell({ cwd: dir.path(), sessionFile: file, sessionId: "different" })).toThrow();
			expect(() => openFileJournalCell({ cwd: dir.path(), sessionFile: missing, sessionId: header.id })).toThrow();
			expect(() => openFileJournalCell({ cwd: dir.path(), sessionDir: dir.path(), sessionId: header.id })).toThrow();
			expect(await Bun.file(missing).exists()).toBe(false);
			await Bun.write(duplicate, bytes);
			expect(() => openFileJournalCell({ cwd: dir.path(), sessionFile: duplicate, sessionId: header.id })).toThrow();
			expect(await Bun.file(file).text()).toBe(bytes);
			expect(await Bun.file(duplicate).text()).toBe(bytes);
		} finally {
			await closeCell(cell);
		}
	});

	it("rejects cell, execution, session, and owner DTOs without issuing any authority or readiness", async () => {
		using dir = TempDir.createSync("@file-principal-dto-");
		const file = path.join(dir.path(), "session.jsonl");
		const fixture = managedFixture(dir.path());
		const bytes = await persist(file, managedEntries(fixture));
		const cell = openFileJournalCell({ cwd: dir.path(), sessionFile: file });
		// No binding: this must not set the process-global journalRequired latch.
		const execution = createJournalExecution({
			agent: { kind: "main", id: "RootAgent", name: "main", depth: 0 }, purpose: "main",
		});
		try {
			const fakeCell = Object.freeze({
				...cell, getSessionId: () => cell.getSessionId(), getSessionFile: () => file,
				getHeader: () => cell.getHeader(), getEntries: () => cell.getEntries(),
			});
			const fakeExecution = Object.freeze({
				...execution, journalState: "required-ready",
				modelRequestScope: {
					sessionId: cell.getSessionId(), rootSessionId: cell.getSessionId(), purpose: "main",
					agent: { kind: "main", id: "RootAgent", name: "main", depth: 0 },
				},
			});
			const fakeOwner = Object.freeze({ journalOwnerId: OWNER, journalEpoch: EPOCH });
			const fakeSession = Object.freeze({ cell, owner: fakeOwner, execution: fakeExecution });
			// Reflect calls deliberately submit invalid DTOs at public runtime boundaries.
			for (const input of [
				{ cell: fakeCell, root: cell, binding: undefined, execution },
				{ cell, root: fakeCell, binding: undefined, execution },
				{ cell, root: cell, binding: undefined, execution: fakeExecution },
			]) {
				await expect((async () => Reflect.apply(composeJournalSession, undefined, [input]))()).rejects.toThrow(unavailable);
			}
			expect(() => assertJournalExecutionIdentity(fakeExecution)).toThrow(unavailable);
			expect(() => Reflect.apply(cell.appendModelRequestMetadata, cell, [fakeOwner, fixture.decision])).toThrow(unavailable);
			expect(() => Reflect.apply(appendJournalMetadata, undefined, [fakeSession, fakeExecution, fixture.decision])).toThrow(unavailable);
			expect(cell.getEntries()).toEqual(managedEntries(fixture).slice(1));
			expect(await Bun.file(file).text()).toBe(bytes);
		} finally {
			await closeCell(cell);
		}
	});

	it("returns detached header, entry-list, and individual-entry snapshots", async () => {
		using dir = TempDir.createSync("@file-principal-detached-");
		const file = path.join(dir.path(), "session.jsonl");
		const fixture = managedFixture(dir.path());
		const bytes = await persist(file, managedEntries(fixture));
		const cell = openFileJournalCell({ cwd: dir.path(), sessionFile: file });
		try {
			const header = cell.getHeader();
			const entries = cell.getEntries();
			const metadata = cell.getEntry(fixture.metadata.id);
			const assistant = cell.getEntry(fixture.assistant.id);
			Reflect.set(header, "id", "caller-mutated");
			if (!header.modelRequestJournal || metadata?.type !== "model_request_metadata" ||
				assistant?.type !== "message" || assistant.message.role !== "assistant") {
				throw new Error("Expected the managed persisted-reader fixture");
			}
			Reflect.set(header.modelRequestJournal.epochs[0]!, "journalOwnerId", "caller-mutated");
			Reflect.set(metadata.record, "event", "caller-mutated");
			Reflect.set(assistant.message.content[0]!, "text", "caller-mutated");
			Reflect.set(entries, "length", 0);
			expect(cell.getHeader()).toEqual(fixture.header);
			expect(cell.getEntries()).toEqual(managedEntries(fixture).slice(1));
			expect(cell.getEntry(fixture.metadata.id)).toEqual(fixture.metadata);
			expect(cell.getEntry(fixture.assistant.id)).toEqual(fixture.assistant);
			expect(await Bun.file(file).text()).toBe(bytes);
		} finally {
			await closeCell(cell);
		}
	});

	it.each(["assistant", "metadata"] as const)(
		"rejects a managed %s append through the adopted old raw writer and later raw storage",
		async kind => {
			using dir = TempDir.createSync("@file-principal-managed-writer-");
			const file = path.join(dir.path(), "session.jsonl");
			const fixture = managedFixture(dir.path());
			const bytes = await persist(file, managedEntries(fixture));
			expect((await loadModelRequestJournalFromFile(file)).throughSeqByEpoch.get(EPOCH)).toBe(2);
			const rawStorage = new FileSessionStorage();
			const oldWriter = rawStorage.openWriter(file);
			const cell = openFileJournalCell({ cwd: dir.path(), sessionFile: file });
			try {
				expect(cell.openWriter(file)).toBe(oldWriter);
				const laterWriter = new FileSessionStorage().openWriter(file);
				expect(laterWriter).toBe(oldWriter);
				const entry: SessionEntry = kind === "assistant"
					? { ...fixture.assistant, id: "raw-assistant" }
					: { ...fixture.metadata, id: "raw-metadata", seq: 3 };
				const line = `${JSON.stringify(entry)}\n`;
				await expect(oldWriter.append(line)).rejects.toThrow();
				await expect(laterWriter.append(line)).rejects.toThrow();
				expect(() => rawStorage.openWriter(file, { flags: "w" })).toThrow();
				expect(await Bun.file(file).text()).toBe(bytes);
				expect(cell.getEntries()).toEqual(managedEntries(fixture).slice(1));
				expect((await loadModelRequestJournalFromFile(file)).throughSeqByEpoch.get(EPOCH)).toBe(2);
			} finally {
				await closeCell(cell);
				await oldWriter.close();
			}
		},
	);

	it.each(["descriptor", "metadata-tail"] as const)(
		"rejects a corrupt managed-hinted tail strictly without touching bytes: %s",
		async hint => {
			using dir = TempDir.createSync("@file-principal-strict-");
			const file = path.join(dir.path(), "session.jsonl");
			const fixture = managedFixture(dir.path());
			const prefix = hint === "descriptor"
				? managedEntries(fixture)
				: [ordinaryHeader(dir.path()), userEntry("ordinary")];
			const bytes = `${prefix.map(entry => JSON.stringify(entry)).join("\n")}\n${
				hint === "descriptor" ? "{BROKEN\n" : '{"type":"model_request_metadata","id":'
			}`;
			await Bun.write(file, bytes);
			await expect(loadSessionFile(file)).rejects.toThrow("Invalid model request journal");
			expect(() => openFileJournalCell({ cwd: dir.path(), sessionFile: file })).toThrow();
			expect(await Bun.file(file).text()).toBe(bytes);
		},
	);

	it("revises immediately visible staged state and preserves a selected leaf through the physical rewrite", async () => {
		using dir = TempDir.createSync("@file-principal-staging-");
		const file = path.join(dir.path(), "session.jsonl");
		const header = ordinaryHeader(dir.path());
		const bytes = serializeTitleSlot({ title: "Before", source: "user", updatedAt: ISO }) +
			`${JSON.stringify(header)}\n`;
		await Bun.write(file, bytes);
		const cell = openFileJournalCell({ cwd: dir.path(), sessionFile: file });
		try {
			const initialRevision = cell.getProjectionRevision();
			const first = userEntry("first");
			cell.appendEntry(first);
			expect(cell.getProjectionRevision()).toBeGreaterThan(initialRevision);
			expect(cell.getLeafId()).toBe(first.id);
			const second = userEntry("second", first.id);
			cell.appendEntry(second);
			expect(cell.getLeafId()).toBe(second.id);
			const beforeBranch = cell.getProjectionRevision();
			cell.branch(first.id);
			expect(cell.getProjectionRevision()).toBeGreaterThan(beforeBranch);
			expect(cell.getLeafId()).toBe(first.id);
			const beforeApply = cell.getProjectionRevision();
			cell.applyEntries({ ...cell.getHeader(), title: "After", titleSource: "user" }, [first, second], first.id, UPDATED_ISO);
			expect(cell.getProjectionRevision()).toBeGreaterThan(beforeApply);
			expect(cell.getTitleUpdatedAt()).toBe(UPDATED_ISO);
			expect(cell.getHeader().title).toBe("After");
			expect(cell.getEntries()).toEqual([first, second]);
			expect(openFileJournalCell({ cwd: dir.path(), sessionFile: file }).getLeafId()).toBe(first.id);
			expect(await Bun.file(file).text()).toBe(bytes);
			expect(cell.getExpectedDiskSize()).toBe(Buffer.byteLength(bytes));
			await cell.ensureOnDisk();
			const visible = await loadEntriesFromFileStream(file);
			expect(visible.entries).toEqual([cell.getHeader(), first, second]);
			expect(visible.titleSlot?.updatedAt).toBe(UPDATED_ISO);
			expect(cell.getLeafId()).toBe(first.id);
			expect(cell.getExpectedDiskSize()).toBe(Buffer.byteLength(await Bun.file(file).text()));
		} finally {
			await closeCell(cell);
		}
	});

	it("snapshots staged inputs and rejects applyEntries session identity mismatches without altering the projection", async () => {
		using dir = TempDir.createSync("@file-principal-snapshot-");
		const file = path.join(dir.path(), "session.jsonl");
		const originalHeader = ordinaryHeader(dir.path());
		const bytes = await persist(file, [originalHeader]);
		const cell = openFileJournalCell({ cwd: dir.path(), sessionFile: file });
		try {
			const header = { ...cell.getHeader(), title: "Staged" };
			const entry = userEntry("staged");
			const entries: SessionEntry[] = [entry];
			cell.applyEntries(header, entries, entry.id, UPDATED_ISO);
			const snapshotHeader = cell.getHeader();
			const snapshotEntries = cell.getEntries();
			const revision = cell.getProjectionRevision();
			header.id = "caller-mutated";
			header.title = "caller-mutated";
			entry.id = "caller-mutated";
			Reflect.set(entry.message, "content", "caller-mutated");
			entries.length = 0;
			expect(cell.getHeader()).toEqual(snapshotHeader);
			expect(cell.getEntries()).toEqual(snapshotEntries);
			expect(cell.getLeafId()).toBe("staged");
			expect(() => cell.applyEntries({ ...snapshotHeader, id: "different" }, snapshotEntries, "staged")).toThrow();
			expect(() => cell.applyEntries(snapshotHeader, snapshotEntries, "missing")).toThrow();
			expect(cell.getHeader()).toEqual(snapshotHeader);
			expect(cell.getEntries()).toEqual(snapshotEntries);
			expect(cell.getProjectionRevision()).toBe(revision);
			expect(cell.getExpectedDiskSize()).toBe(Buffer.byteLength(bytes));
			expect(await Bun.file(file).text()).toBe(bytes);
		} finally {
			await closeCell(cell);
		}
	});

	it("keeps the last committed byte count when an ordinary synchronous rewrite loses its expectedSize precondition", async () => {
		using dir = TempDir.createSync("@file-principal-conflict-");
		const file = path.join(dir.path(), "session.jsonl");
		const bytes = await persist(file, [ordinaryHeader(dir.path()), userEntry("first")]);
		const cell = openFileJournalCell({ cwd: dir.path(), sessionFile: file });
		try {
			const expectedSize = cell.getExpectedDiskSize();
			cell.appendEntry(userEntry("staged", "first"));
			const externallyChanged = `${bytes}${JSON.stringify(userEntry("external", "first"))}\n`;
			// A noncooperating external writer changes disk, not the cell's committed snapshot.
			await Bun.write(file, externallyChanged);
			expect(() => cell.flushSync()).toThrow(SessionWriteConflictError);
			expect(cell.getExpectedDiskSize()).toBe(expectedSize);
			expect(cell.getEntries().map(entry => entry.id)).toEqual(["first", "staged"]);
			expect(await Bun.file(file).text()).toBe(externallyChanged);
			expect((await loadSessionFile(file)).entries.slice(1).map(entry => entry.type !== "session" ? entry.id : null)).toEqual(["first", "external"]);
		} finally {
			await closeCell(cell);
		}
	});

	it("protects managed snapshot identities, closed metadata, and source kinds in applyEntries", async () => {
		using dir = TempDir.createSync("@file-principal-managed-apply-");
		const file = path.join(dir.path(), "session.jsonl");
		const fixture = managedFixture(dir.path());
		const bytes = await persist(file, managedEntries(fixture));
		const cell = openFileJournalCell({ cwd: dir.path(), sessionFile: file });
		try {
			const header = cell.getHeader();
			const entries = cell.getEntries();
			const revision = cell.getProjectionRevision();
			const descriptor = header.modelRequestJournal;
			if (!descriptor) throw new Error("Expected persisted journal descriptor");
			const attempts: { header: SessionHeader; entries: readonly SessionEntry[] }[] = [
				{ header: { ...header, id: "different" }, entries },
				{ header: { ...header, modelRequestJournal: { ...descriptor, journalId: crypto.randomUUID() } }, entries },
				{ header: { ...header, modelRequestJournal: undefined }, entries },
				{ header, entries: entries.filter(entry => entry.id !== fixture.metadata.id) },
				{ header, entries: entries.map(entry => entry.id === fixture.metadata.id ? { ...fixture.metadata, id: "different" } : entry) },
				{ header, entries: entries.map(entry => entry.id === fixture.metadata.id ? { ...fixture.metadata, timestamp: UPDATED_ISO } : entry) },
				{ header, entries: entries.map(entry => entry.id === fixture.assistant.id ? { ...fixture.assistant, id: "different" } : entry) },
				{ header, entries: entries.map(entry => entry.id === fixture.assistant.id ? userEntry(fixture.assistant.id) : entry) },
				{ header, entries: [...entries, { ...fixture.metadata, id: "new-metadata", seq: 3 }] },
				{ header, entries: [...entries, { ...fixture.assistant, id: "new-source" }] },
			];
			for (const attempt of attempts) {
				expect(() => cell.applyEntries(attempt.header, attempt.entries, fixture.assistant.id)).toThrow();
				expect(cell.getHeader()).toEqual(header);
				expect(cell.getEntries()).toEqual(entries);
				expect(cell.getProjectionRevision()).toBe(revision);
				expect(cell.getLeafId()).toBe(fixture.assistant.id);
			}
			expect(() => cell.branch(fixture.metadata.id)).toThrow();
			expect(cell.getExpectedDiskSize()).toBe(Buffer.byteLength(bytes));
			expect(await Bun.file(file).text()).toBe(bytes);
			expect((await loadModelRequestJournalFromFile(file)).metadataEntries).toEqual([fixture.metadata, fixture.linked]);
		} finally {
			await closeCell(cell);
		}
	});
});
