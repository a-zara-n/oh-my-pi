import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadModelRequestJournalFromFile, loadSessionFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	createJournalExecution,
	FileSessionStorage,
	openFileJournalCell,
} from "@oh-my-pi/pi-utils/model-request-journal-composition";
import type { FileJournalCell } from "@oh-my-pi/pi-utils/model-request-journal-composition";
import type { FileEntry } from "@oh-my-pi/pi-utils/session-entries";
import { serializeTitleSlot } from "@oh-my-pi/pi-utils/session-title-slot";
import { EPOCH, fileEntries, ISO, userEntry } from "./fixtures/file-principal-append-integrity";

const unavailable = /Model request journal capability is unavailable/;

function serialize(entries: readonly FileEntry[]): string {
	return `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`;
}

async function closeCell(cell: FileJournalCell): Promise<void> {
	try { await cell.close(); } finally { cell.releaseRetainedEntries(); }
}

function physicalEntries(content: string): unknown[] {
	return content.trimEnd().split("\n").map(line => {
		const value: unknown = JSON.parse(line);
		return value;
	});
}

async function foreignAppend(file: string, sessionId: string, entry: FileEntry): Promise<void> {
	const child = Bun.spawn([
		process.execPath, path.join(import.meta.dir, "fixtures/file-principal-append-integrity.ts"),
		"--foreign-append", file, sessionId, `${JSON.stringify(entry)}\n`,
	], { stdout: "pipe", stderr: "pipe", env: process.env });
	const [exit, stdout, stderr] = await Promise.all([
		child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
	]);
	if (exit !== 0) throw new Error(`Foreign append fixture failed (${exit}): ${stderr}`);
	expect(stdout.trim()).toBe("FOREIGN_COMMITTED");
}

const rejectedRecords = [
	{ name: "folded title slot plus user", line: () => serializeTitleSlot({ title: "injected", updatedAt: ISO }) + serialize([userEntry("injected")]) },
	{ name: "two user records", line: () => serialize([userEntry("injected"), userEntry("second-injected")]) },
	{ name: "title slot alone", line: () => serializeTitleSlot({ title: "injected", updatedAt: ISO }) },
	{ name: "null", line: () => "null\n" },
	{ name: "array", line: () => `${JSON.stringify([userEntry("injected")])}\n` },
	{ name: "unknown type", line: () => `${JSON.stringify({ ...userEntry("injected"), type: "unknown" })}\n` },
	{ name: "prototype type name", line: () => `${JSON.stringify({ ...userEntry("injected"), type: "toString" })}\n` },
	{ name: "non-string type", line: () => `${JSON.stringify({ ...userEntry("injected"), type: 1 })}\n` },
	{ name: "noncanonical id", line: () => serialize([userEntry("invalid id")]) },
	{ name: "empty id", line: () => serialize([userEntry("")]) },
	{ name: "wrong parent type", line: () => `${JSON.stringify({ ...userEntry("injected"), parentId: 1 })}\n` },
	{ name: "missing message", line: () => `${JSON.stringify({ type: "message", id: "injected", parentId: null, timestamp: ISO })}\n` },
	{ name: "null message", line: () => `${JSON.stringify({ ...userEntry("injected"), message: null })}\n` },
	{ name: "unterminated record", line: () => JSON.stringify(userEntry("injected")) },
	{ name: "extra blank physical row", line: () => `${serialize([userEntry("injected")])}\n` },
	{ name: "session header", line: () => serialize([fileEntries("/unused", false)[0]!]) },
	{ name: "closed metadata", line: () => serialize([fileEntries("/unused", true)[1]!]) },
	{ name: "managed assistant source", line: () => serialize([{ ...fileEntries("/unused", true)[2]!, id: "new-assistant" }]) },
];

describe("File principal physical append integrity", () => {
	it.each([false, true])("recovers a separate child's committed rows before a facade rewrite (managed=%s)", async managed => {
		using dir = TempDir.createSync("@principal-foreign-append-");
		const file = dir.join("session.jsonl");
		const initial = fileEntries(dir.path(), managed);
		await Bun.write(file, serialize(initial));
		const manager = await SessionManager.open(file, dir.path(), new FileSessionStorage(), { suppressBreadcrumb: true });
		const cell = openFileJournalCell({ cwd: dir.path(), sessionFile: file });
		try {
			const warm = manager.appendMessage({ role: "user", content: "warm", timestamp: 1 });
			await manager.flush();
			const writer = cell.openWriter(file);
			expect(writer.isOpen()).toBe(true);
			const staged = userEntry("staged", warm);
			cell.appendEntry(staged);
			const foreign = userEntry("foreign", warm);
			await foreignAppend(file, cell.getSessionId(), foreign);
			expect(physicalEntries(await Bun.file(file).text())).toContainEqual(foreign);
			const own = manager.appendMessage({ role: "user", content: "own", timestamp: 2 });
			await manager.flush();
			// Exercise the real facade's revision/index shortcut as well as the cell.
			expect(manager.getEntry(foreign.id)).toEqual(foreign);
			expect(cell.getEntry(foreign.id)).toEqual(foreign);
			expect(manager.getEntry(staged.id)).toEqual(staged);
			expect(cell.getEntry(staged.id)).toEqual(staged);
			expect(manager.getLeafId()).toBe(own);
			expect(cell.getLeafId()).toBe(own);
			expect(cell.getExpectedDiskSize()).toBe(fs.statSync(file).size);
			await manager.rewriteEntries();
			await manager.flush();
			const bytes = await Bun.file(file).text();
			const physical = physicalEntries(bytes);
			const loaded = await loadSessionFile(file);
			for (const entry of [foreign, staged, manager.getEntry(own)]) {
				expect(entry).toBeDefined();
				expect(physical).toContainEqual(entry);
				expect(loaded.entries).toContainEqual(entry);
			}
			expect(loaded.entries.slice(1)).toEqual(cell.getEntries());
			expect(manager.getEntries()).toEqual(cell.getEntries());
			expect(cell.getExpectedDiskSize()).toBe(Buffer.byteLength(bytes));
			for (const entry of initial.slice(1)) expect(cell.getEntry(entry.id)).toEqual(entry);
			if (managed) {
				const journal = await loadModelRequestJournalFromFile(file);
				expect(journal.metadataEntries.map(entry => entry.id)).toEqual(["metadata1", "metadata2"]);
				expect(journal.throughSeqByEpoch.get(EPOCH)).toBe(2);
				expect(journal.metadataEntries[1]?.record).toMatchObject({ sourceEntryId: "assistant1" });
			}
		} finally {
			try { await manager.close(); } finally { cell.releaseRetainedEntries(); }
		}
	}, 30_000);

	it.each(rejectedRecords)("rejects $name before bytes, projection, or readiness changes", async ({ line }) => {
		using dir = TempDir.createSync("@principal-raw-framing-");
		const file = dir.join("session.jsonl");
		await Bun.write(file, serialize(fileEntries(dir.path(), true)));
		const cell = openFileJournalCell({ cwd: dir.path(), sessionFile: file });
		const execution = createJournalExecution({
			agent: { kind: "main", id: "RootAgent", name: "main", depth: 0 }, purpose: "main",
		});
		try {
			const writer = new FileSessionStorage().openWriter(file);
			expect(writer).toBe(cell.openWriter(file));
			const before = {
				bytes: await Bun.file(file).text(), header: cell.getHeader(), entries: cell.getEntries(),
				leaf: cell.getLeafId(), size: cell.getExpectedDiskSize(), revision: cell.getProjectionRevision(),
				state: execution.journalState, scope: execution.modelRequestScope,
				journal: await loadModelRequestJournalFromFile(file),
			};
			await expect(writer.append(line())).rejects.toThrow(unavailable);
			expect(await Bun.file(file).text()).toBe(before.bytes);
			expect(cell.getHeader()).toEqual(before.header);
			expect(cell.getEntries()).toEqual(before.entries);
			for (const entry of before.entries) expect(cell.getEntry(entry.id)).toEqual(entry);
			expect(cell.getEntry("injected")).toBeUndefined();
			expect(cell.getLeafId()).toBe(before.leaf);
			expect(cell.getExpectedDiskSize()).toBe(before.size);
			expect(cell.getProjectionRevision()).toBe(before.revision);
			expect(execution.journalState).toBe(before.state);
			expect(execution.modelRequestScope).toBe(before.scope);
			expect(await loadModelRequestJournalFromFile(file)).toEqual(before.journal);
			expect((await loadSessionFile(file)).entries).toEqual([before.header, ...before.entries]);
			// Rejection must not poison the real writer or the principal.
			const accepted = userEntry("accepted", before.leaf);
			await writer.append(serialize([accepted]));
			await writer.flush();
			expect(cell.getEntry(accepted.id)).toEqual(accepted);
			expect(cell.getExpectedDiskSize()).toBe(fs.statSync(file).size);
			expect((await loadModelRequestJournalFromFile(file)).throughSeqByEpoch.get(EPOCH)).toBe(2);
		} finally { await closeCell(cell); }
	});

	it.each(["unknown", "title", "invalid id"])("shares the strict rewrite boundary for %s rows", async kind => {
		using dir = TempDir.createSync("@principal-closed-row-");
		const file = dir.join("session.jsonl");
		const entries = fileEntries(dir.path(), true);
		const bytes = serialize(entries);
		await Bun.write(file, bytes);
		const cell = openFileJournalCell({ cwd: dir.path(), sessionFile: file });
		try {
			const row = kind === "invalid id" ? userEntry(kind) : { ...userEntry("injected"), type: kind };
			await expect(new FileSessionStorage().writeTextAtomic(file, `${bytes}${JSON.stringify(row)}\n`)).rejects.toThrow(unavailable);
			expect(await Bun.file(file).text()).toBe(bytes);
			expect(cell.getEntries()).toEqual(entries.slice(1));
			expect(cell.getExpectedDiskSize()).toBe(Buffer.byteLength(bytes));
		} finally { await closeCell(cell); }
	});
});
