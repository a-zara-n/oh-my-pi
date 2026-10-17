import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { exportSessionToHtml } from "@oh-my-pi/pi-coding-agent/export/html/index";
import { loadModelRequestJournalFromFile, loadSessionFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import type { SessionPersistenceNotice } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	FileSessionStorage,
	openFileJournalCell,
	SessionWriteConflictError,
	tryAcquireSessionLease,
} from "@oh-my-pi/pi-utils/model-request-journal-composition";
import type { FileJournalCell, SessionStorageWriter } from "@oh-my-pi/pi-utils/model-request-journal-composition";
import type {
	FileEntry,
	ModelRequestLifecycleRecord,
	ModelRequestMetadataEntry,
	SessionHeader,
	SessionMessageEntry,
} from "@oh-my-pi/pi-utils/session-entries";

const ISO = "2026-10-16T00:00:00.000Z";
const JOURNAL = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const EPOCH = "33333333-3333-4333-8333-333333333333";
const ATTEMPT = "44444444-4444-4444-8444-444444444444";
const REQUEST = "55555555-5555-4555-8555-555555555555";

function ordinaryHeader(cwd: string): SessionHeader {
	return { type: "session", version: 3, id: crypto.randomUUID(), timestamp: ISO, cwd };
}

function userEntry(id: string, parentId: string | null = null): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: ISO,
		message: { role: "user", content: `message ${id}`, timestamp: 1 },
	};
}

function serialize(entries: readonly FileEntry[]): string {
	return `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`;
}

async function persist(file: string, entries: readonly FileEntry[]): Promise<string> {
	const bytes = serialize(entries);
	await Bun.write(file, bytes);
	return bytes;
}

async function disposeCell(cell: FileJournalCell): Promise<void> {
	try {
		await cell.close();
	} finally {
		cell.releaseRetainedEntries();
	}
}

/** Distinguish fixture preparation failures from exercised regression failures. */
async function atStage<T>(label: string, operation: () => T | PromiseLike<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
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
	// Same persisted-reader data construction as file-session-principal.test.ts.
	// These bytes neither issue an owner nor register a ready execution.
	const sessionId = crypto.randomUUID();
	const header: SessionHeader = {
		type: "session",
		version: 3,
		id: sessionId,
		timestamp: ISO,
		cwd,
		modelRequestJournal: {
			schemaVersion: 1,
			journalId: JOURNAL,
			sessionId,
			epochs: [{ journalOwnerId: OWNER, journalEpoch: EPOCH }],
		},
	};
	const decision: ModelRequestLifecycleRecord = {
		schemaVersion: 1,
		event: "decision",
		coreAttemptId: ATTEMPT,
		requestId: REQUEST,
		coreRetryOf: null,
		rootSessionId: sessionId,
		sessionId,
		purpose: "main",
		modelRef: { provider: "openai", id: "gpt-5", api: "openai-responses" },
		atMs: 1,
		decision: "pass",
	};
	const metadata: ModelRequestMetadataEntry = {
		type: "model_request_metadata",
		id: "metadata1",
		parentId: null,
		timestamp: ISO,
		schemaVersion: 1,
		journalId: JOURNAL,
		sessionId,
		journalOwnerId: OWNER,
		journalEpoch: EPOCH,
		seq: 1,
		record: decision,
	};
	const assistant: SessionMessageEntry = {
		type: "message",
		id: "assistant1",
		parentId: null,
		timestamp: ISO,
		message: {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5",
			stopReason: "stop",
			timestamp: 1,
			content: [{ type: "text", text: "reader fixture" }],
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	};
	const linked: ModelRequestMetadataEntry = {
		...metadata,
		id: "metadata2",
		seq: 2,
		record: {
			schemaVersion: 1,
			sourceKind: "assistant",
			sourceSessionId: sessionId,
			sourceEntryId: assistant.id,
			resultId: null,
			provenance: { kind: "non-wire", reason: "cache" },
		},
	};
	return { header, decision, metadata, assistant, linked };
}

function managedEntries(fixture: ManagedFixture): FileEntry[] {
	return [fixture.header, fixture.metadata, fixture.assistant, fixture.linked];
}

/** Inspect actual structuredClone arguments, not implementation source or a fake store. */
function includesHistoricalEntry(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	if ("id" in value && typeof value.id === "string" && value.id.startsWith("history-")) return true;
	return Object.values(value).some(includesHistoricalEntry);
}

describe("File principal consumer compatibility regressions", () => {
	it("creates and persists through the natural TempDir path without a caller realpath workaround", async () => {
		using dir = TempDir.createSync("@principal-natural-directory-");
		const manager = await atStage("setup: SessionManager.create with unmodified TempDir.path()", () =>
			SessionManager.create(dir.path(), dir.path(), new FileSessionStorage()),
		);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a file-backed session");
		const cell = openFileJournalCell({ cwd: dir.path(), sessionFile });
		try {
			await manager.ensureOnDisk();
			const id = manager.appendMessage({ role: "user", content: "natural directory", timestamp: 1 });
			await manager.flush();
			const file = manager.getSessionFile();
			if (!file) throw new Error("Expected a file-backed session");
			expect(fs.realpathSync(path.dirname(file))).toBe(fs.realpathSync(dir.path()));
			expect(manager.getEntry(id)).toBeDefined();
			expect<readonly (FileEntry | null)[]>((await loadSessionFile(file)).entries).toEqual([
				manager.getHeader(),
				...manager.getEntries(),
			]);
		} finally {
			try {
				await manager.close();
			} finally {
				cell.releaseRetainedEntries();
			}
		}
	});

	it("loads, reads, and exports under an actual foreign lease, then appends only to a sibling", async () => {
		using dir = TempDir.createSync("@principal-foreign-lease-");
		const file = dir.join("session.jsonl");
		const header = ordinaryHeader(dir.path());
		const bytes = await persist(file, [header, userEntry("first")]);
		const child = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "fixtures/file-principal-lease-holder.ts"), header.id],
			{ stdin: "pipe", stdout: "pipe", stderr: "pipe", env: process.env },
		);
		let manager: SessionManager | undefined;
		let cell: FileJournalCell | undefined;
		try {
			const stdout = child.stdout.getReader();
			const ready = await stdout.read();
			stdout.releaseLock();
			if (ready.done) throw new Error(`Lease child exited: ${await new Response(child.stderr).text()}`);
			expect(new TextDecoder().decode(ready.value).trim()).toBe("READY");
			// Proves OS lease contention, rather than merely trusting child output.
			const unexpectedLease = tryAcquireSessionLease(header.id);
			try {
				expect(unexpectedLease).toBeNull();
			} finally {
				unexpectedLease?.release();
			}
			expect((await loadSessionFile(file)).entries).toEqual([header, userEntry("first")]);
			manager = await atStage("target: open facade under actual foreign lease", () =>
				SessionManager.open(file, dir.path(), undefined, { suppressBreadcrumb: true }),
			);
			cell = openFileJournalCell({ cwd: dir.path(), sessionFile: file });
			expect(manager.getHeader()).toEqual(header);
			expect(manager.getEntries()).toEqual([userEntry("first")]);
			expect(manager.getLeafId()).toBe("first");
			const html = await exportSessionToHtml(manager, undefined, {
				outputPath: dir.join("export.html"),
				includeSubSessions: false,
			});
			expect(await Bun.file(html).text()).toContain("<!DOCTYPE html>");
			expect(await Bun.file(file).text()).toBe(bytes);
			const notices: SessionPersistenceNotice[] = [];
			manager.onPersistenceNotice(notice => notices.push(notice));
			const id = manager.appendMessage({ role: "user", content: "contender", timestamp: 2 });
			await manager.flush();
			const sibling = manager.getSessionFile();
			if (!sibling) throw new Error("Expected a persisted sibling session");
			expect(sibling).not.toBe(file);
			expect(fs.realpathSync(path.dirname(sibling))).toBe(fs.realpathSync(dir.path()));
			expect(notices).toHaveLength(1);
			expect(notices[0]?.reason).toBe("open-elsewhere");
			expect(fs.realpathSync(notices[0]!.from)).toBe(fs.realpathSync(file));
			expect(fs.realpathSync(notices[0]!.to)).toBe(fs.realpathSync(sibling));
			expect(manager.getEntry(id)).toMatchObject({ id, parentId: "first" });
			expect<readonly (FileEntry | null)[]>((await loadSessionFile(sibling)).entries).toEqual([
				manager.getHeader(),
				...manager.getEntries(),
			]);
			expect(await Bun.file(file).text()).toBe(bytes);
		} finally {
			try {
				await manager?.close();
			} finally {
				cell?.releaseRetainedEntries();
				child.stdin.write("close\n");
				child.stdin.end();
				await child.exited;
			}
		}
	}, 30_000);

	it("does not latch an old cell's failed atomic close onto a newly selected facade session", async () => {
		using dir = TempDir.createSync("@principal-switch-error-");
		const oldFile = dir.join("old.jsonl");
		const nextFile = dir.join("new.jsonl");
		const oldBytes = await persist(oldFile, [ordinaryHeader(dir.path()), userEntry("old")]);
		await persist(nextFile, [ordinaryHeader(dir.path()), userEntry("new")]);
		const manager = await atStage("setup: open old facade before inducing its write failure", () =>
			SessionManager.open(oldFile, dir.path(), undefined, { suppressBreadcrumb: true }),
		);
		const old = openFileJournalCell({ cwd: dir.path(), sessionFile: oldFile });
		const failures: Error[] = [];
		manager.onPersistenceError(error => failures.push(error));
		try {
			// A real failed freshness precondition: no fabricated backend failure.
			await expect(
				old.writeTextAtomic(oldFile, oldBytes, {
					expectedSize: -1,
					requireAtomicReplace: true,
				}),
			).rejects.toThrow(SessionWriteConflictError);
			expect(await Bun.file(oldFile).text()).toBe(oldBytes);
			await atStage("target: switch away from old failed cell and flush new facade", async () => {
				await manager.setSessionFile(nextFile);
				await manager.flush();
			});
			const selectedFile = manager.getSessionFile();
			if (!selectedFile) throw new Error("Expected the newly selected session");
			expect(fs.realpathSync(selectedFile)).toBe(fs.realpathSync(nextFile));
			const id = manager.appendMessage({ role: "user", content: "after switch", timestamp: 2 });
			await manager.flush();
			expect(manager.getEntry(id)).toBeDefined();
			expect(await Bun.file(nextFile).text()).toContain("after switch");
			expect(await Bun.file(oldFile).text()).toBe(oldBytes);
			expect(failures).toEqual([]);
		} finally {
			try {
				await manager.close();
			} finally {
				old.releaseRetainedEntries();
				openFileJournalCell({ cwd: dir.path(), sessionFile: nextFile }).releaseRetainedEntries();
			}
		}
	});

	it("appends incrementally without full-file reads or cloning retained history", async () => {
		using dir = TempDir.createSync("@principal-hot-append-");
		const file = dir.join("session.jsonl");
		const history = Array.from({ length: 128 }, (_, index) =>
			userEntry(`history-${index}`, index ? `history-${index - 1}` : null),
		);
		await persist(file, [ordinaryHeader(dir.path()), ...history]);
		const cell = await atStage("setup: open actual hot-append cell", () =>
			openFileJournalCell({ cwd: dir.path(), sessionFile: file }),
		);
		try {
			const writer = await atStage("setup: open actual hot-append writer", () => cell.openWriter(file));
			await atStage("setup: warm actual hot-append writer", () =>
				writer.append(`${JSON.stringify(userEntry("warm", "history-127"))}\n`),
			);
			const beforeSize = fs.statSync(file).size;
			const entry = userEntry("hot", "warm");
			const line = `${JSON.stringify(entry)}\n`;
			// spyOn without mockImplementation is pass-through: all real I/O and cloning occurs.
			const reads = spyOn(fs, "readFileSync");
			const clones = spyOn(globalThis, "structuredClone");
			let fullReads = 0;
			let historyClones = 0;
			try {
				await atStage("target: logical hot appendEntry", () => cell.appendEntry(entry));
				await atStage("target: raw hot append and flush", async () => {
					await writer.append(line);
					await writer.flush();
				});
				fullReads = reads.mock.calls.filter(args => String(args[0]) === file).length;
				historyClones = clones.mock.calls.filter(args => includesHistoricalEntry(args[0])).length;
			} finally {
				reads.mockRestore();
				clones.mockRestore();
			}
			expect({ fullReads, historyClones }).toEqual({ fullReads: 0, historyClones: 0 });
			expect(cell.getExpectedDiskSize()).toBe(beforeSize + Buffer.byteLength(line));
			expect<number | null>(fs.statSync(file).size).toBe(cell.getExpectedDiskSize());
			expect(cell.getEntries()).toEqual([...history, userEntry("warm", "history-127"), entry]);
			expect(cell.getLeafId()).toBe(entry.id);
			expect<readonly FileEntry[]>((await loadSessionFile(file)).entries.slice(1)).toEqual(cell.getEntries());
		} finally {
			await disposeCell(cell);
		}
	});

	it("keeps v1 migrated IDs and the caller's exact new ID when adopting a raw writer", async () => {
		using dir = TempDir.createSync("@principal-legacy-writer-");
		const file = dir.join("session.jsonl");
		const header = { ...ordinaryHeader(dir.path()), version: 1 };
		await Bun.write(
			file,
			`${JSON.stringify(header)}\n${JSON.stringify({
				type: "message",
				timestamp: ISO,
				message: { role: "user", content: "legacy", timestamp: 1 },
			})}\n`,
		);
		const writer = new FileSessionStorage().openWriter(file);
		const cell = openFileJournalCell({ cwd: dir.path(), sessionFile: file });
		try {
			const prefix = cell.getEntries();
			const originalLeaf = cell.getLeafId();
			expect(originalLeaf).toEqual(expect.any(String));
			const entry = userEntry("caller-exact-new-id", originalLeaf);
			expect(cell.openWriter(file)).toBe(writer);
			await writer.append(`${JSON.stringify(entry)}\n`);
			await writer.flush();
			expect(cell.getEntries()).toEqual([...prefix, entry]);
			expect(cell.getLeafId()).toBe(entry.id);
			expect(cell.getEntry(originalLeaf!)).toEqual(prefix[0]);
			const loaded = await loadSessionFile(file);
			expect(loaded.entries[0]).toMatchObject({ id: header.id, version: 3 });
			expect(loaded.entries.slice(1)).toEqual([...prefix, entry]);
			expect(cell.getExpectedDiskSize()).toBe(Buffer.byteLength(await Bun.file(file).text()));
		} finally {
			try {
				await disposeCell(cell);
			} finally {
				await writer.close();
			}
		}
	});

	it.each(["original", "copy", "hardlink"] as const)(
		"refuses unadopted managed flags:w before O_TRUNC through a %s path",
		async kind => {
			using dir = TempDir.createSync("@principal-unadopted-truncate-");
			const file = dir.join("managed.jsonl");
			const alias = dir.join("alias.jsonl");
			const bytes = await persist(file, managedEntries(managedFixture(dir.path())));
			if (kind === "copy") fs.copyFileSync(file, alias);
			if (kind === "hardlink") fs.linkSync(file, alias);
			const target = kind === "original" ? file : alias;
			const opens = spyOn(fs, "openSync");
			let writer: SessionStorageWriter | undefined;
			try {
				expect(() => {
					writer = new FileSessionStorage().openWriter(target, { flags: "w" });
				}).toThrow();
				const truncations = opens.mock.calls.filter(args => {
					if (String(args[0]) !== target) return false;
					const flags = args[1];
					return typeof flags === "number" ? (flags & fs.constants.O_TRUNC) !== 0 : flags.startsWith("w");
				});
				expect(truncations).toEqual([]);
			} finally {
				opens.mockRestore();
				await writer?.close();
			}
			expect(await Bun.file(file).text()).toBe(bytes);
			expect(await Bun.file(target).text()).toBe(bytes);
			expect((await loadModelRequestJournalFromFile(target)).throughSeqByEpoch.get(EPOCH)).toBe(2);
		},
	);

	it.each(["text", "lines"] as const)(
		"allows a managed no-op public %s atomic rewrite without opening raw managed copies",
		async format => {
			using dir = TempDir.createSync("@principal-managed-noop-");
			const file = dir.join("managed.jsonl");
			const fixture = managedFixture(dir.path());
			const entries = managedEntries(fixture);
			const bytes = await persist(file, entries);
			const cell = await atStage("setup: open managed persisted-reader cell", () =>
				openFileJournalCell({ cwd: dir.path(), sessionFile: file }),
			);
			try {
				const options = { expectedSize: Buffer.byteLength(bytes), requireAtomicReplace: true };
				await atStage(`target: managed no-op ${format} atomic wrapper`, async () => {
					if (format === "text") await cell.writeTextAtomic(file, bytes, options);
					else
						await cell.writeLinesAtomic!(
							file,
							entries.map(entry => `${JSON.stringify(entry)}\n`),
							options,
						);
				});
				expect(await Bun.file(file).text()).toBe(bytes);
				expect<readonly FileEntry[]>(cell.getEntries()).toEqual(entries.slice(1));
				expect((await loadModelRequestJournalFromFile(file)).metadataEntries).toEqual([
					fixture.metadata,
					fixture.linked,
				]);
				// An exact managed copy is still forbidden through raw storage, including a new destination.
				const copied = dir.join("raw-copy.jsonl");
				await expect(new FileSessionStorage().writeTextAtomic(copied, bytes)).rejects.toThrow();
				expect(await Bun.file(copied).exists()).toBe(false);
				const forbidden = serialize([...entries, { ...fixture.assistant, id: "forged-assistant" }]);
				await expect(new FileSessionStorage().writeTextAtomic(file, forbidden)).rejects.toThrow();
				const snapshot = cell.getEntries();
				for (const replacement of [
					snapshot.filter(entry => entry.id !== fixture.metadata.id),
					snapshot.map(entry =>
						entry.id === fixture.metadata.id
							? { ...fixture.metadata, timestamp: "2026-10-17T00:00:00.000Z" }
							: entry,
					),
					[...snapshot, { ...fixture.metadata, id: "forged-metadata", seq: 3 }],
					[...snapshot, { ...fixture.assistant, id: "forged-source" }],
				]) {
					expect(() => cell.applyEntries(cell.getHeader(), replacement, fixture.assistant.id)).toThrow();
					expect(cell.getEntries()).toEqual(snapshot);
				}
				expect(await Bun.file(file).text()).toBe(bytes);
			} finally {
				await disposeCell(cell);
			}
		},
	);

	it("reconnects a facade without replacing an existing cell's draft or selected branch with disk", async () => {
		using dir = TempDir.createSync("@principal-live-reconnect-");
		const file = dir.join("session.jsonl");
		const bytes = await persist(file, [ordinaryHeader(dir.path()), userEntry("first"), userEntry("second", "first")]);
		const cell = await atStage("setup: open existing branch cell", () =>
			openFileJournalCell({ cwd: dir.path(), sessionFile: file }),
		);
		await atStage("setup: stage draft before reconnect", () => cell.appendEntry(userEntry("draft", "second")));
		await atStage("setup: select non-tail branch before reconnect", () => cell.branch("first"));
		const snapshot = cell.getEntries();
		let manager: SessionManager | undefined;
		try {
			manager = await atStage("target: reconnect facade over drafted live cell", () =>
				SessionManager.open(file, dir.path(), undefined, { suppressBreadcrumb: true }),
			);
			expect(openFileJournalCell({ cwd: dir.path(), sessionFile: file })).toBe(cell);
			expect(cell.getEntries()).toEqual(snapshot);
			expect<readonly FileEntry[]>(manager.getEntries()).toEqual(snapshot);
			expect(cell.getLeafId()).toBe("first");
			expect(manager.getLeafId()).toBe("first");
			expect(await Bun.file(file).text()).toBe(bytes);
		} finally {
			try {
				await manager?.close();
			} finally {
				await disposeCell(cell);
			}
		}
	});

	it.each(["release", "reset", "adopt"] as const)(
		"does not let stale terminal %s evict the cell reopened under the same path and ID",
		async action => {
			using dir = TempDir.createSync("@principal-stale-terminal-");
			const file = dir.join("session.jsonl");
			const bytes = await persist(file, [ordinaryHeader(dir.path()), userEntry("first")]);
			const stale = openFileJournalCell({ cwd: dir.path(), sessionFile: file });
			await stale.close();
			stale.releaseRetainedEntries();
			const current = openFileJournalCell({ cwd: dir.path(), sessionFile: file });
			try {
				expect(current).not.toBe(stale);
				await atStage("setup: stage draft in reopened current cell", () =>
					current.appendEntry(userEntry("draft", "first")),
				);
				// Refusing a stale operation is fine; silently evicting another current cell is not.
				try {
					if (action === "release") stale.releaseRetainedEntries();
					else if (action === "reset") stale.resetToNewSession();
					else {
						const next = dir.join("other.jsonl");
						await persist(next, [ordinaryHeader(dir.path()), userEntry("other")]);
						await stale.setSessionFile(next);
					}
				} catch {
					/* A terminal stale handle may reject reuse. */
				}
				expect(openFileJournalCell({ cwd: dir.path(), sessionFile: file })).toBe(current);
				expect(current.getEntries()).toEqual([userEntry("first"), userEntry("draft", "first")]);
				expect(current.getLeafId()).toBe("draft");
				expect(await Bun.file(file).text()).toBe(bytes);
				current.appendEntry(userEntry("still-current", "draft"));
				expect(current.getLeafId()).toBe("still-current");
			} finally {
				try {
					await disposeCell(current);
				} finally {
					await disposeCell(stale);
				}
			}
		},
	);
});
