import "../../../scripts/audit-library-bootstrap";
import { describe, expect, test } from "bun:test";
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
} from "../src/model-request-journal-authority";
import {
	appendJournalMetadata,
	assertJournalExecutionReady,
	closeJournalSession,
	composeJournalSession,
	createJournalExecution,
	deriveJournalExecution,
	openFileJournalCell,
	type FileJournalCell,
	type JournalSession,
	type ModelRequestExecution,
} from "../src/model-request-journal-composition";
import { withRawModelRequestJournalLeases } from "../src/model-request-journal-leases";
import { openModelRequestJournalDatabase } from "../src/model-request-journal-sqlite-control";
import type { ModelRequestLifecycleRecord } from "../src/session-entries";

interface ReadyPrincipal {
	readonly cell: FileJournalCell;
	readonly execution: ModelRequestExecution;
	readonly session: JournalSession;
}

// Actual native authority setup from the r11 consumer fixture. Only production
// composition creates ready principals; these rows authenticate the real verifier.
class CompositionFixture {
	readonly directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "journal-composition-claims-")));
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
		retainModelRequestWriterCredential(this.requester, {
			writerId: this.writerId, token, role: "operator-command", capabilities: [],
		});
		const physicalBindingId = randomUUID();
		const common = "seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,tx_seq INTEGER NOT NULL,created_at_ms INTEGER NOT NULL";
		this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA application_id=1330856277; PRAGMA user_version=20;
			CREATE TABLE store_meta(singleton INTEGER PRIMARY KEY,store_id TEXT) STRICT;
			CREATE TABLE tx_log(tx_seq INTEGER PRIMARY KEY,writer_id TEXT,op_name TEXT,sealed INTEGER) STRICT;
			CREATE TABLE writer(${common},role TEXT NOT NULL,capabilities_json TEXT NOT NULL,agent_kind TEXT,omp_agent_id TEXT,depth INTEGER,parent_writer_id TEXT,omp_session_id TEXT,token_hash TEXT NOT NULL,host_pid INTEGER,component_version_id TEXT) STRICT;
			CREATE TABLE writer_event(${common},writer_id TEXT NOT NULL,event TEXT NOT NULL,reason TEXT) STRICT;
			CREATE TABLE store_config_event(${common},key TEXT NOT NULL,value_json TEXT NOT NULL,approval_id TEXT,writer_id TEXT NOT NULL) STRICT;`);
		this.db.query("INSERT INTO store_meta VALUES(1,?)").run(this.storeId);
		this.db.query("INSERT INTO tx_log VALUES(1,?,'store.init',1),(2,?,'bootstrapModelRequestJournalAuthority',1),(3,?,'registerWriter',1)")
			.run(epochWriterId, epochWriterId, epochWriterId);
		this.db.query("INSERT INTO writer(id,tx_seq,created_at_ms,role,capabilities_json,token_hash) VALUES(?,1,1,'operator-command','[]',?),(?,3,3,'operator-command','[]',?)")
			.run(epochWriterId, createHash("sha256").update(randomBytes(32)).digest("hex"), this.writerId,
				createHash("sha256").update(token).digest("hex"));
		this.db.query("INSERT INTO store_config_event(id,tx_seq,created_at_ms,key,value_json,approval_id,writer_id) VALUES('epoch-1',2,2,'budget_authority_epoch',?,NULL,?)")
			.run(JSON.stringify({ schemaVersion: 1, authorityEpoch: 1, physicalBindingId }), epochWriterId);
		withRawModelRequestJournalLeases({ storeId: this.storeId, control: "exclusive", maintenance: "exclusive" }, raw => {
			this.namespace = raw.namespacePath;
			const stat = fs.statSync(databasePath);
			fs.writeFileSync(raw.recordPath, JSON.stringify({
				schemaVersion: 1, storeId: this.storeId, authorityEpoch: 1, physicalBindingId,
				dbDevice: stat.dev, dbInode: stat.ino, state: "active",
			}), { mode: 0o600 });
		});
	}

	open(sessionFile?: string): FileJournalCell {
		const cell = openFileJournalCell({ cwd: this.directory, sessionDir: this.directory,
			...(sessionFile === undefined ? {} : { sessionFile }),
		});
		this.cells.push(cell);
		return cell;
	}

	withBinding<T>(root: FileJournalCell, use: (binding: ModelRequestJournalLeaseBinding) => Promise<T>): Promise<T> {
		return withVerifiedModelRequestJournalBinding({ resources: this.resources, requester: this.requester,
			mode: "resume", rootSessionId: root.getSessionId() }, use);
	}

	execution(binding: ModelRequestJournalLeaseBinding, parent?: ReadyPrincipal): ModelRequestExecution {
		return createJournalExecution({ binding,
			agent: { id: randomUUID(), kind: parent ? "sub" : "main", name: "claims", depth: parent ? 1 : 0 },
			purpose: "main", ...(parent === undefined ? {} : { parentExecution: parent.execution }),
		});
	}

	async ready(binding: ModelRequestJournalLeaseBinding, cell: FileJournalCell, parent?: ReadyPrincipal): Promise<ReadyPrincipal> {
		const execution = this.execution(binding, parent);
		const session = await composeJournalSession({ cell, root: parent?.cell ?? cell, binding, execution });
		return { cell, execution, session };
	}

	async close(): Promise<void> {
		await Promise.allSettled([...this.cells].reverse().map(cell => cell.close()));
		try { retireModelRequestWriterCredential(this.requester); this.db.close(); }
		finally {
			fs.rmSync(this.directory, { recursive: true, force: true });
			if (this.namespace) fs.rmSync(this.namespace, { recursive: true, force: true });
		}
	}
}

function decision(cell: FileJournalCell, root: FileJournalCell): ModelRequestLifecycleRecord {
	return { schemaVersion: 1, event: "decision", coreAttemptId: randomUUID(), requestId: randomUUID(),
		coreRetryOf: null, rootSessionId: root.getSessionId(), sessionId: cell.getSessionId(), purpose: "main",
		modelRef: { provider: "openai", id: "fixture-model", api: "openai-completions" }, atMs: 1, decision: "pass" };
}

const mac = process.platform === "darwin" ? describe : describe.skip;
mac("actual File composition claims", () => {
	test("ready family rejects a second cell without moving its scope or losing the original close", async () => {
		const fixture = new CompositionFixture();
		try {
			const rootCell = fixture.open();
			await fixture.withBinding(rootCell, async binding => {
				const root = await fixture.ready(binding, rootCell);
				const child = await fixture.ready(binding, fixture.open(), root);
				const derived = deriveJournalExecution(child.execution, { purpose: "title" });
				const other = fixture.open();
				await other.ensureOnDisk();
				const rootBytes = fs.readFileSync(rootCell.getSessionFile(), "utf8");
				const otherBytes = fs.readFileSync(other.getSessionFile(), "utf8");
				await expect(composeJournalSession({ cell: other, root: rootCell, binding, execution: derived })).rejects.toThrow();
				expect(fs.readFileSync(rootCell.getSessionFile(), "utf8")).toBe(rootBytes);
				expect(fs.readFileSync(other.getSessionFile(), "utf8")).toBe(otherBytes);
				expect(derived.modelRequestScope?.sessionId).toBe(child.cell.getSessionId());
				assertJournalExecutionReady(child.execution);
				expect(await composeJournalSession({ cell: child.cell, root: rootCell, binding, execution: derived })).toBe(child.session);
				await appendJournalMetadata(child.session, derived, decision(child.cell, rootCell));
				await closeJournalSession(root.session);
				const closes = rootCell.getEntries().filter(entry => entry.type === "model_request_registry" &&
					entry.record.sessionId === child.cell.getSessionId() &&
					(entry.record.event === "member-closed" || entry.record.event === "owner-closed"));
				expect(closes).toHaveLength(2);
				for (const entry of closes) expect(entry).toMatchObject({ record: { throughSeq: 1, outcome: "closed" } });
			});
		} finally { await fixture.close(); }
	});

	for (const contender of ["same-family-other-cell", "other-family-same-cell", "same-family-same-cell"] as const) {
		test(`in-progress composition rejects ${contender} before registration`, async () => {
			const fixture = new CompositionFixture();
			try {
				const rootCell = fixture.open();
				await fixture.withBinding(rootCell, async binding => {
					const root = await fixture.ready(binding, rootCell);
					const cell = fixture.open();
					const other = contender === "same-family-other-cell" ? fixture.open() : cell;
					await other.ensureOnDisk();
					const execution = fixture.execution(binding, root);
					const otherExecution = contender === "other-family-same-cell" ? fixture.execution(binding, root) : execution;
					const before = fs.readFileSync(other.getSessionFile(), "utf8");
					const first = composeJournalSession({ cell, root: rootCell, binding, execution });
					const second = composeJournalSession({ cell: other, root: rootCell, binding, execution: otherExecution });
					await expect(second).rejects.toThrow();
					const session = await first;
					assertJournalExecutionReady(execution);
					expect(await composeJournalSession({ cell, root: rootCell, binding, execution })).toBe(session);
					if (other !== cell) expect(fs.readFileSync(other.getSessionFile(), "utf8")).toBe(before);
					const members = rootCell.getEntries().filter(entry => entry.type === "model_request_registry" &&
						entry.record.event === "member-registered" && entry.record.sessionId === cell.getSessionId());
					expect(members).toHaveLength(1);
					await closeJournalSession(root.session);
				});
			} finally { await fixture.close(); }
		});
	}
});

mac("actual File historical composition mappings", () => {
	for (const mode of ["same-root", "missing-first-epoch", "wrong-root", "legacy-held"] as const) {
		test(`${mode} preserves history and requires every old epoch in the selected schema2 root`, async () => {
			const fixture = new CompositionFixture();
			try {
				let rootFile: string | undefined;
				let childFile: string | undefined;
				// Two genuine epochs ensure validation cannot check only the latest.
				for (let round = 0; round < 2; round++) {
					const rootCell = fixture.open(rootFile);
					await fixture.withBinding(rootCell, async binding => {
						const root = await fixture.ready(binding, rootCell);
						const child = await fixture.ready(binding, fixture.open(childFile), root);
						rootFile = rootCell.getSessionFile();
						childFile = child.cell.getSessionFile();
						await appendJournalMetadata(child.session, child.execution, decision(child.cell, rootCell));
						await closeJournalSession(root.session);
						await Promise.all([...fixture.cells].reverse().map(cell => cell.close()));
					});
				}
				if (!rootFile || !childFile) throw new Error("Missing actual historical files");
				const historical = fixture.open(childFile);
				const childHeader = historical.getHeader();
				const childEntries = historical.getEntries();
				const oldEpochs = childHeader.modelRequestJournal?.epochs;
				if (!oldEpochs || oldEpochs.length !== 2) throw new Error("Missing actual historical epochs");
				await historical.close();
				if (mode === "missing-first-epoch" || mode === "legacy-held") {
					const oldRoot = fixture.open(rootFile);
					const header = oldRoot.getHeader();
					const descriptor = header.modelRequestRegistry;
					if (!descriptor) throw new Error("Missing actual historical registry");
					const entries = oldRoot.getEntries();
					await oldRoot.close();
					let seq = 0;
					const retained = entries.filter(entry => entry.type !== "model_request_registry" ||
						entry.record.sessionId !== childHeader.id ||
						(mode === "missing-first-epoch" && entry.record.journalEpoch !== oldEpochs[0]!.journalEpoch));
					const rows = retained.map(entry => entry.type === "model_request_registry" ? { ...entry, seq: ++seq } : entry);
					// A held child's descriptor alone is not a root mapping. Removing
					// all its mappings simulates legacy history without backfilling.
					const title = fs.readFileSync(rootFile, "utf8").split("\n")[0];
					fs.writeFileSync(rootFile, `${title}\n${JSON.stringify(header)}\n${rows.map(entry => JSON.stringify(entry)).join("\n")}\n`);
				}
				const rootCell = mode === "wrong-root" ? fixture.open() : fixture.open(rootFile);
				let checked = false;
				try {
					await fixture.withBinding(rootCell, async binding => {
						const root = await fixture.ready(binding, rootCell);
						const childCell = fixture.open(childFile);
						const execution = fixture.execution(binding, root);
						const rootBefore = fs.readFileSync(rootCell.getSessionFile(), "utf8");
						const childBefore = fs.readFileSync(childCell.getSessionFile(), "utf8");
						const pending = composeJournalSession({ cell: childCell, root: rootCell, binding, execution });
						if (mode === "same-root") {
							const session = await pending;
							assertJournalExecutionReady(execution);
							expect<typeof oldEpochs | undefined>(childCell.getHeader().modelRequestJournal?.epochs.slice(0, 2)).toEqual(oldEpochs);
							expect(childCell.getEntries()).toEqual(childEntries);
							for (const entry of childEntries) expect(fs.readFileSync(childCell.getSessionFile(), "utf8")).toContain(`${JSON.stringify(entry)}\n`);
							await appendJournalMetadata(session, execution, decision(childCell, rootCell));
							await closeJournalSession(root.session);
							await Promise.all([...fixture.cells].reverse().map(cell => cell.close()));
						} else {
							await expect(pending).rejects.toThrow();
							expect(execution.journalState).not.toBe("required-ready");
							expect(fs.readFileSync(rootCell.getSessionFile(), "utf8")).toBe(rootBefore);
							expect(fs.readFileSync(childCell.getSessionFile(), "utf8")).toBe(childBefore);
						}
						checked = true;
					});
				} catch (error) {
					// A failed verified lease invalidates its binding; a later exit
					// verification is distinct from the observed compose rejection.
					if (!checked) throw error;
				}
				expect(checked).toBe(true);
			} finally { await fixture.close(); }
		});
	}
});
