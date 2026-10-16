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
	close(): void;
}
async function fixture(): Promise<SQLiteFixture> {
	const directory = mkdtempSync(join(tmpdir(), "journal-authority-db-"));
	const storeId = `test-${randomUUID()}`;
	const databasePath = join(directory, "state.sqlite3");
	const db = new Database(databasePath);
	chmodSync(databasePath, 0o600);
	const writerId = `writer-${randomUUID()}`;
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
	db.query("INSERT INTO tx_log VALUES(1,?,'store.init',1),(2,?,'bootstrapModelRequestJournalAuthority',1)").run(writerId, writerId);
	db.query("INSERT INTO writer(id,tx_seq,created_at_ms,role,capabilities_json,token_hash) VALUES(?,1,1,'operator-command','[]',?)").run(writerId, hash);
	db.query("INSERT INTO store_config_event(id,tx_seq,created_at_ms,key,value_json,approval_id,writer_id) VALUES('epoch-1',2,2,'budget_authority_epoch',?,NULL,?)").run(JSON.stringify({schemaVersion: 1, authorityEpoch: 1, physicalBindingId}), writerId);
	let namespace: string | undefined;
	await withRawModelRequestJournalLeases({storeId, control: "exclusive", maintenance: "exclusive"}, async raw => {
		namespace = raw.namespacePath;
		const stat = statSync(databasePath);
		writeFileSync(raw.recordPath, JSON.stringify({schemaVersion: 1, storeId, authorityEpoch: 1, physicalBindingId, dbDevice: stat.dev, dbInode: stat.ino, state: "active"}), {mode: 0o600});
	});
	return {
		db, resources: {storeId, databasePath}, requester,
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
			input.db.exec("UPDATE writer SET role='cli-tool'; BEGIN IMMEDIATE; UPDATE writer SET role='operator-command'");
			let entered = false;
			const request = {resources: input.resources, requester: input.requester, mode: "resume" as const, rootSessionId: "root"};
			await expect(withVerifiedModelRequestJournalBinding(request, async () => { entered = true; })).rejects.toThrow("requester rejected");
			input.db.exec("ROLLBACK");
			await expect(withVerifiedModelRequestJournalBinding(request, async () => { entered = true; })).rejects.toThrow("requester rejected");
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
			input.db.query("INSERT INTO tx_log SELECT 3,id,'endWriter',1 FROM writer").run();
			input.db.query("INSERT INTO writer_event(id,tx_seq,created_at_ms,writer_id,event,reason) SELECT 'ended',3,3,id,'ended',NULL FROM writer").run();
			await expect(withVerifiedModelRequestJournalBinding({resources: input.resources, requester: input.requester, mode: "resume", rootSessionId: "root"}, async () => {})).rejects.toThrow("requester rejected");
		} finally { input.close(); }
	});
});
