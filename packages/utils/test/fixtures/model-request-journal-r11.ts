import type { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	retainModelRequestWriterCredential,
	retireModelRequestWriterCredential,
	withVerifiedModelRequestJournalBinding,
	type ModelRequestJournalAuthorityResources,
	type ModelRequestJournalLeaseBinding,
} from "../../src/model-request-journal-authority";
import {
	composeJournalSession,
	createJournalExecution,
	openFileJournalCell,
	type FileJournalCell,
	type JournalSession,
	type ModelRequestExecution,
} from "../../src/model-request-journal-composition";
import { withRawModelRequestJournalLeases } from "../../src/model-request-journal-leases";
import { openModelRequestJournalDatabase } from "../../src/model-request-journal-sqlite-control";
import type { ModelRequestAgent } from "../../src/model-request-data";

export interface ReadyPrincipal {
	readonly cell: FileJournalCell;
	readonly execution: ModelRequestExecution;
	readonly session: JournalSession;
}

/** Same real native SQLite/credential setup as model-request-journal-authority-sqlite.test.ts.
 * The authority record bootstraps the actual verifier, never a scope/proof issuer.
 * Every ready journal below is registered exclusively by production composition.
 */
export class R11JournalFixture {
	readonly directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "journal-r11-consumer-")));
	readonly storeId = `test-${randomUUID()}`;
	readonly writerId = `writer-${randomUUID()}`;
	readonly requester = Object.freeze({ writerId: this.writerId });
	readonly resources: ModelRequestJournalAuthorityResources;
	readonly db: Database;
	readonly cells: FileJournalCell[] = [];
	namespace = "";

	constructor() {
		const databasePath = path.join(this.directory, "state.sqlite3");
		fs.writeFileSync(databasePath, "", { mode: 0o600 });
		this.db = openModelRequestJournalDatabase(databasePath, { strict: true, safeIntegers: false });
		fs.chmodSync(databasePath, 0o600);
		this.resources = { storeId: this.storeId, databasePath };
		const epochWriterId = `writer-${randomUUID()}`;
		const token = randomBytes(32);
		const hash = createHash("sha256").update(token).digest("hex");
		retainModelRequestWriterCredential(this.requester, {
			writerId: this.writerId,
			token,
			role: "operator-command",
			capabilities: [],
		});
		const physicalBindingId = randomUUID();
		const common =
			"seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,tx_seq INTEGER NOT NULL,created_at_ms INTEGER NOT NULL";
		this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA application_id=1330856277; PRAGMA user_version=20;
			CREATE TABLE store_meta(singleton INTEGER PRIMARY KEY,store_id TEXT) STRICT;
			CREATE TABLE tx_log(tx_seq INTEGER PRIMARY KEY,writer_id TEXT,op_name TEXT,sealed INTEGER) STRICT;
			CREATE TABLE writer(${common},role TEXT NOT NULL,capabilities_json TEXT NOT NULL,agent_kind TEXT,omp_agent_id TEXT,depth INTEGER,parent_writer_id TEXT,omp_session_id TEXT,token_hash TEXT NOT NULL,host_pid INTEGER,component_version_id TEXT) STRICT;
			CREATE TABLE writer_event(${common},writer_id TEXT NOT NULL,event TEXT NOT NULL,reason TEXT) STRICT;
			CREATE TABLE store_config_event(${common},key TEXT NOT NULL,value_json TEXT NOT NULL,approval_id TEXT,writer_id TEXT NOT NULL) STRICT;`);
		this.db.query("INSERT INTO store_meta VALUES(1,?)").run(this.storeId);
		this.db
			.query(
				"INSERT INTO tx_log VALUES(1,?,'store.init',1),(2,?,'bootstrapModelRequestJournalAuthority',1),(3,?,'registerWriter',1)",
			)
			.run(epochWriterId, epochWriterId, epochWriterId);
		this.db
			.query(
				"INSERT INTO writer(id,tx_seq,created_at_ms,role,capabilities_json,token_hash) VALUES(?,1,1,'operator-command','[]',?),(?,3,3,'operator-command','[]',?)",
			)
			.run(epochWriterId, createHash("sha256").update(randomBytes(32)).digest("hex"), this.writerId, hash);
		this.db
			.query(
				"INSERT INTO store_config_event(id,tx_seq,created_at_ms,key,value_json,approval_id,writer_id) VALUES('epoch-1',2,2,'budget_authority_epoch',?,NULL,?)",
			)
			.run(JSON.stringify({ schemaVersion: 1, authorityEpoch: 1, physicalBindingId }), epochWriterId);
		withRawModelRequestJournalLeases(
			{ storeId: this.storeId, control: "exclusive", maintenance: "exclusive" },
			raw => {
				this.namespace = raw.namespacePath;
				const stat = fs.statSync(databasePath);
				fs.writeFileSync(
					raw.recordPath,
					JSON.stringify({
						schemaVersion: 1,
						storeId: this.storeId,
						authorityEpoch: 1,
						physicalBindingId,
						dbDevice: stat.dev,
						dbInode: stat.ino,
						state: "active",
					}),
					{ mode: 0o600 },
				);
			},
		);
	}

	open(sessionFile?: string): FileJournalCell {
		const cell = openFileJournalCell({
			cwd: this.directory,
			sessionDir: sessionFile === undefined ? this.directory : path.dirname(sessionFile),
			...(sessionFile === undefined ? {} : { sessionFile }),
		});
		this.cells.push(cell);
		return cell;
	}

	withBinding<T>(root: FileJournalCell, use: (binding: ModelRequestJournalLeaseBinding) => Promise<T>): Promise<T> {
		return withVerifiedModelRequestJournalBinding(
			{ resources: this.resources, requester: this.requester, mode: "resume", rootSessionId: root.getSessionId() },
			use,
		);
	}

	async ready(
		binding: ModelRequestJournalLeaseBinding,
		cell: FileJournalCell,
		parent?: ReadyPrincipal,
		agent: ModelRequestAgent = {
			id: randomUUID(),
			kind: parent ? "sub" : "main",
			name: "r11",
			depth: parent ? 1 : 0,
		},
		root: FileJournalCell = parent?.cell ?? cell,
	): Promise<ReadyPrincipal> {
		const execution = createJournalExecution({
			binding,
			agent,
			purpose: "main",
			...(parent === undefined ? {} : { parentExecution: parent.execution }),
		});
		const session = await composeJournalSession({ cell, root, binding, execution });
		return { cell, execution, session };
	}

	async close(): Promise<void> {
		// Fault/revocation cases intentionally leave cells unable to publish a close.
		// Still settle every real queue/descriptor before removing scratch data.
		await Promise.allSettled([...this.cells].reverse().map(cell => cell.close()));
		try {
			retireModelRequestWriterCredential(this.requester);
			this.db.close();
		} finally {
			fs.rmSync(this.directory, { recursive: true, force: true });
			if (this.namespace) fs.rmSync(this.namespace, { recursive: true, force: true });
		}
	}
}
