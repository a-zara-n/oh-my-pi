import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retainModelRequestWriterCredential, retireModelRequestWriterCredential, withVerifiedModelRequestJournalBinding, type ModelRequestJournalAuthorityResources } from "../src/model-request-journal-authority";
import { withRawModelRequestJournalLeases } from "../src/model-request-journal-leases";

const mac = process.platform === "darwin" ? describe : describe.skip;
interface SQLiteFixture {
	readonly db: Database;
	readonly resources: ModelRequestJournalAuthorityResources;
	readonly requester: object;
	readonly requesterWriterId: string;
	close(): void;
}
async function fixture(): Promise<SQLiteFixture> {
	const directory = mkdtempSync(join(tmpdir(), "journal-authority-db-"));
	const storeId = `test-${randomUUID()}`;
	const databasePath = join(directory, "state.sqlite3");
	const db = new Database(databasePath);
	chmodSync(databasePath, 0o600);
	const writerId = `writer-${randomUUID()}`;
	const epochWriterId = `writer-${randomUUID()}`;
	const requester = Object.freeze({writerId});
	const token = randomBytes(32);
	const hash = createHash("sha256").update(token).digest("hex");
	retainModelRequestWriterCredential(requester, {writerId, token, role: "operator-command", capabilities: []});
	const physicalBindingId = randomUUID();
	const common = "seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,tx_seq INTEGER NOT NULL,created_at_ms INTEGER NOT NULL";
	db.exec(`PRAGMA journal_mode=WAL; PRAGMA application_id=1330856277; PRAGMA user_version=20;
		CREATE TABLE store_meta(singleton INTEGER PRIMARY KEY,store_id TEXT) STRICT;
		CREATE TABLE tx_log(tx_seq INTEGER PRIMARY KEY,writer_id TEXT,op_name TEXT,sealed INTEGER) STRICT;
		CREATE TABLE writer(${common},role TEXT NOT NULL,capabilities_json TEXT NOT NULL,agent_kind TEXT,omp_agent_id TEXT,depth INTEGER,parent_writer_id TEXT,omp_session_id TEXT,token_hash TEXT NOT NULL,host_pid INTEGER,component_version_id TEXT) STRICT;
		CREATE TABLE writer_event(${common},writer_id TEXT NOT NULL,event TEXT NOT NULL,reason TEXT) STRICT;
		CREATE TABLE store_config_event(${common},key TEXT NOT NULL,value_json TEXT NOT NULL,approval_id TEXT,writer_id TEXT NOT NULL) STRICT;`);
	db.query("INSERT INTO store_meta VALUES(1,?)").run(storeId);
	db.query("INSERT INTO tx_log VALUES(1,?,'store.init',1),(2,?,'bootstrapModelRequestJournalAuthority',1),(3,?,'registerWriter',1)").run(epochWriterId, epochWriterId, epochWriterId);
	db.query("INSERT INTO writer(id,tx_seq,created_at_ms,role,capabilities_json,token_hash) VALUES(?,1,1,'operator-command','[]',?),(?,3,3,'operator-command','[]',?)").run(epochWriterId, createHash("sha256").update(randomBytes(32)).digest("hex"), writerId, hash);
	db.query("INSERT INTO store_config_event(id,tx_seq,created_at_ms,key,value_json,approval_id,writer_id) VALUES('epoch-1',2,2,'budget_authority_epoch',?,NULL,?)").run(JSON.stringify({schemaVersion: 1, authorityEpoch: 1, physicalBindingId}), epochWriterId);
	let namespace: string | undefined;
	await withRawModelRequestJournalLeases({storeId, control: "exclusive", maintenance: "exclusive"}, async raw => {
		namespace = raw.namespacePath;
		const stat = statSync(databasePath);
		writeFileSync(raw.recordPath, JSON.stringify({schemaVersion: 1, storeId, authorityEpoch: 1, physicalBindingId, dbDevice: stat.dev, dbInode: stat.ino, state: "active"}), {mode: 0o600});
	});
	return {
		db, resources: {storeId, databasePath}, requester, requesterWriterId: writerId,
		close() {
			try { retireModelRequestWriterCredential(requester); db.close(); } finally {
				rmSync(directory, {recursive: true, force: true});
				if (namespace !== undefined) rmSync(namespace, {recursive: true, force: true});
			}
		},
	};
}

mac("self-opened SQLite fixed authority rejections", () => {
	test("real registered credential cannot authenticate a modified database token", async () => {
		const input = await fixture();
		try {
			input.db.exec("UPDATE writer SET token_hash='0000000000000000000000000000000000000000000000000000000000000000'");
			let entered = false;
			await expect(withVerifiedModelRequestJournalBinding({resources: input.resources, requester: input.requester, mode: "resume", rootSessionId: "root"}, async () => { entered = true; })).rejects.toThrow("requester rejected");
			expect(entered).toBe(false);
		} finally { input.close(); }
	});
	test("uncommitted permission changes and rollback are not caller-supplied proof", async () => {
		const input = await fixture();
		try {
			input.db.query("UPDATE writer SET role='cli-tool' WHERE id=?").run(input.requesterWriterId);
			input.db.exec("BEGIN IMMEDIATE");
			input.db.query("UPDATE writer SET role='operator-command' WHERE id=?").run(input.requesterWriterId);
			let entered = false;
			const request = {resources: input.resources, requester: input.requester, mode: "resume" as const, rootSessionId: "root"};
			const observer = new Database(input.resources.databasePath, {readonly: true, strict: true});
			try {
				expect(input.db.query<{role: string}, [string]>("SELECT role FROM writer WHERE id=?").get(input.requesterWriterId)?.role).toBe("operator-command");
				expect(observer.query<{role: string}, [string]>("SELECT role FROM writer WHERE id=?").get(input.requesterWriterId)?.role).toBe("cli-tool");
				expect(observer.query<{role: string}, []>("SELECT w.role FROM writer w JOIN store_config_event e ON e.writer_id=w.id WHERE e.key='budget_authority_epoch'").get()?.role).toBe("operator-command");
				await expect(withVerifiedModelRequestJournalBinding(request, async () => { entered = true; })).rejects.toThrow();
				input.db.exec("ROLLBACK");
				expect(observer.query<{role: string}, [string]>("SELECT role FROM writer WHERE id=?").get(input.requesterWriterId)?.role).toBe("cli-tool");
				await expect(withVerifiedModelRequestJournalBinding(request, async () => { entered = true; })).rejects.toThrow();
			} finally { observer.close(); }
			expect(entered).toBe(false);
		} finally { input.close(); }
	});

	test("unknown schema fields and unknown epoch JSON fields fail the limited codec", async () => {
		for (const mutation of ["ALTER TABLE writer ADD COLUMN unknown_field TEXT", "UPDATE store_config_event SET value_json=json_set(value_json,'$.unknown',1)"]) {
			const input = await fixture();
			try {
				input.db.exec(mutation);
				let entered = false;
				await expect(withVerifiedModelRequestJournalBinding({resources: input.resources, requester: input.requester, mode: "resume", rootSessionId: "root"}, async () => { entered = true; })).rejects.toThrow(mutation.startsWith("ALTER") ? "control schema rejected" : "epoch codec rejected");
				expect(entered).toBe(false);
			} finally { input.close(); }
		}
	});

	test("real ended event rejects the requester without relying on local retirement", async () => {
		const input = await fixture();
		try {
			input.db.query("INSERT INTO tx_log VALUES(4,?,'endWriter',1)").run(input.requesterWriterId);
			input.db.query("INSERT INTO writer_event(id,tx_seq,created_at_ms,writer_id,event,reason) VALUES('ended',4,4,?,'ended',NULL)").run(input.requesterWriterId);
			await expect(withVerifiedModelRequestJournalBinding({resources: input.resources, requester: input.requester, mode: "resume", rootSessionId: "root"}, async () => {})).rejects.toThrow("requester rejected");
		} finally { input.close(); }
	});
});
