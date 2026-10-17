import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertModelRequestJournalDatabase, createModelRequestJournalDatabase, openModelRequestJournalDatabase } from "../src/model-request-journal-sqlite-control";

// This suite requires the approved pinned audit preload. No alternative fd/stat proof or native mock is accepted.
const mac = process.platform === "darwin" && process.arch === "arm64" ? describe : describe.skip;
mac("owned SQLite fixed control", () => {
	test("exclusive creation, same connection read snapshot and actual transaction generations", () => {
		const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "owned-sqlite-")));
		try {
			const created = createModelRequestJournalDatabase(path.join(directory, "state.sqlite3"));
			try {
				expect(created.storeId).toMatch(/^[0-9a-f]{32}$/);
				expect(fs.readFileSync(path.join(directory, "STORE_ID"), "utf8")).toBe(created.storeId);
				expect(created.identity).toBeDefined();
				expect(() => createModelRequestJournalDatabase(path.join(directory, "state.sqlite3"))).toThrow();
				const first = assertModelRequestJournalDatabase(created.database);
				created.database.exec("PRAGMA journal_mode=WAL; CREATE TABLE evidence(id INTEGER PRIMARY KEY,value TEXT) STRICT; INSERT INTO evidence VALUES(1,'kept')");
				const reader = openModelRequestJournalDatabase(path.join(directory, "state.sqlite3"), {readonly: true, create: false, strict: true});
				try {
					reader.exec("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; BEGIN");
					expect(reader.query<{value: string}, []>("SELECT value FROM evidence").get()?.value).toBe("kept");
					const snapshot = assertModelRequestJournalDatabase(reader);
					expect(snapshot.device).toBe(first.device);
					expect(snapshot.main.presence).toBe(1);
					expect(snapshot.wal.presence).toBe(1);
					expect(snapshot.shm.presence).toBe(1);
					expect(snapshot.wal.generation).toBeGreaterThan(0n);
					expect(snapshot.shm.generation).toBeGreaterThan(0n);
					expect(snapshot.inode).toBe(first.inode);
					expect(snapshot.transactionState).toBe(1);
					expect(snapshot.transactionGeneration).toBeGreaterThan(0n);
					created.database.exec("UPDATE evidence SET value='new'");
					expect(reader.query<{value: string}, []>("SELECT value FROM evidence").get()?.value).toBe("kept");
					expect(assertModelRequestJournalDatabase(reader).transactionGeneration).toBe(snapshot.transactionGeneration);
					reader.exec("ROLLBACK; BEGIN");
					expect(reader.query<{value: string}, []>("SELECT value FROM evidence").get()?.value).toBe("new");
					expect(assertModelRequestJournalDatabase(reader).transactionGeneration).toBeGreaterThan(snapshot.transactionGeneration);
					expect(() => reader.exec("UPDATE evidence SET value='forbidden'")).toThrow();
					reader.exec("ROLLBACK");
				} finally { reader.close(); }
				const backupPath = path.join(directory, "backup.sqlite3");
				const backupSource = openModelRequestJournalDatabase(path.join(directory, "state.sqlite3"), {readonly: true, create: false, strict: true});
				try {
					backupSource.exec("PRAGMA query_only=OFF");
					backupSource.query("VACUUM INTO ?").run(backupPath);
					assertModelRequestJournalDatabase(backupSource);
					expect(() => backupSource.exec("UPDATE evidence SET value='forbidden'")).toThrow();
				} finally { backupSource.close(); }
				const backup = openModelRequestJournalDatabase(backupPath, {readonly: true, create: false, strict: true});
				try {
					expect(backup.query<{value: string}, []>("SELECT value FROM evidence").get()?.value).toBe("new");
					const copied = assertModelRequestJournalDatabase(backup);
					expect(copied.inode).not.toBe(first.inode);
					expect(copied.liveWriterGenerations).toHaveLength(0);
				} finally { backup.close(); }
				created.database.close();
				expect(() => assertModelRequestJournalDatabase(created.database)).toThrow();
			} finally { created.database.close(); }
		} finally { fs.rmSync(directory, {recursive: true, force: true}); }
	});

	test("foreign objects, memory probes, unknown options and prior connection generations are not proof", () => {
		const memory = new Database(":memory:");
		try { expect(() => assertModelRequestJournalDatabase(memory)).toThrow(); }
		finally { memory.close(); }
		expect(() => openModelRequestJournalDatabase("file:/tmp/forbidden?immutable=1")).toThrow();
		expect(() => openModelRequestJournalDatabase(":memory:", {readonly: true, create: true})).toThrow();
		const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "owned-reopen-")));
		try {
			const created = createModelRequestJournalDatabase(path.join(directory, "state.sqlite3"));
			created.database.exec("CREATE TABLE evidence(id INTEGER PRIMARY KEY) STRICT");
			const original = assertModelRequestJournalDatabase(created.database);
			created.database.close();
			const replacement = openModelRequestJournalDatabase(path.join(directory, "state.sqlite3"), {create: false});
			try {
				expect(assertModelRequestJournalDatabase(replacement).connectionGeneration).not.toBe(original.connectionGeneration);
				expect(() => assertModelRequestJournalDatabase(created.database)).toThrow();
			} finally { replacement.close(); }
		} finally { fs.rmSync(directory, {recursive: true, force: true}); }
	});

	test("writer-owned B cannot borrow reader-owned A identity after path swap-back", () => {
		const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "owned-swap-")));
		const filename = path.join(directory, "state.sqlite3");
		try {
			const created = createModelRequestJournalDatabase(filename);
			created.database.exec("CREATE TABLE evidence(id INTEGER PRIMARY KEY) STRICT");
			created.database.close();
			fs.renameSync(filename, `${filename}.A`);
			fs.copyFileSync(`${filename}.A`, filename);
			fs.chmodSync(filename, 0o600);
			const writerB = openModelRequestJournalDatabase(filename, {create: false});
			try {
				fs.renameSync(filename, `${filename}.B`);
				fs.renameSync(`${filename}.A`, filename);
				expect(() => {
					const readerA = openModelRequestJournalDatabase(filename, {readonly: true, create: false});
					try { assertModelRequestJournalDatabase(readerA); } finally { readerA.close(); }
				}).toThrow();
			} finally { expect(() => writerB.close()).toThrow(); }
		} finally { fs.rmSync(directory, {recursive: true, force: true}); }
	});

	test("managed close rejects actual main identity loss even when unchecked close is requested", () => {
		for (const throwOnError of [undefined, false, true]) {
			const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "owned-close-")));
			const filename = path.join(directory, "state.sqlite3");
			const moved = `${filename}.moved`;
			try {
				const created = createModelRequestJournalDatabase(filename);
				created.database.exec("CREATE TABLE evidence(id INTEGER PRIMARY KEY) STRICT");
				created.database.close();
				const reader = openModelRequestJournalDatabase(filename, {readonly: true, create: false});
				try {
					expect(assertModelRequestJournalDatabase(reader).inode).toBeGreaterThan(0);
					fs.renameSync(filename, moved);
					try {
						expect(() => reader.close(throwOnError)).toThrow();
						expect(() => assertModelRequestJournalDatabase(reader)).toThrow();
					} finally { fs.renameSync(moved, filename); }
				} finally { reader.close(); }
			} finally { fs.rmSync(directory, {recursive: true, force: true}); }
		}
	});
});
