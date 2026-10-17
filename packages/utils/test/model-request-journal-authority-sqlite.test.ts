import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, closeSync, fstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retainModelRequestWriterCredential, retainVerifiedModelRequestJournalRoot, retireModelRequestWriterCredential, withVerifiedModelRequestJournalBinding, withVerifiedModelRequestJournalLeases, type ModelRequestJournalAuthorityResources, type ModelRequestJournalLeaseBinding, type ModelRequestJournalRetainedRootScope } from "../src/model-request-journal-authority";
import { tryAcquireRawModelRequestJournalFileLease, withRawModelRequestJournalLeases } from "../src/model-request-journal-leases";
import { assertModelRequestJournalDatabase, openModelRequestJournalDatabase } from "../src/model-request-journal-sqlite-control";

const mac = process.platform === "darwin" ? describe : describe.skip;
interface SQLiteFixture {
	readonly db: Database;
	readonly resources: ModelRequestJournalAuthorityResources;
	readonly requester: object;
	readonly requesterWriterId: string;
	close(): void;
}
async function fixture(): Promise<SQLiteFixture> {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "journal-authority-db-")));
	const storeId = `test-${randomUUID()}`;
	const databasePath = join(directory, "state.sqlite3");
	writeFileSync(databasePath, "", {mode: 0o600});
	const db = openModelRequestJournalDatabase(databasePath, {strict: true, safeIntegers: false});
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

// Fault the actual retained fd, not a mock lease or a caller-authored proof.
function closeActualRootDescriptor(path: string): void {
	const expected = statSync(path);
	const descriptors: number[] = [];
	for (const entry of readdirSync("/dev/fd")) {
		if (!/^\d+$/.test(entry)) continue;
		const fd = Number(entry);
		try {
			const actual = fstatSync(fd);
			if (actual.dev === expected.dev && actual.ino === expected.ino) descriptors.push(fd);
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "EBADF") throw error;
		}
	}
	if (descriptors.length !== 1) throw new Error("Expected one actual retained root fd");
	closeSync(descriptors[0]!);
}

mac("self-opened SQLite fixed authority rejections", () => {
	test("owned RO snapshot and live writer permit real credential binding and root scope", async () => {
		const input = await fixture();
		let entered = 0;
		try {
			const owned = assertModelRequestJournalDatabase(input.db);
			expect(owned.liveWriterGenerations).toHaveLength(1);
			await withVerifiedModelRequestJournalBinding({resources: input.resources, requester: input.requester, mode: "resume", rootSessionId: "root"}, async binding => {
				entered++;
				await withVerifiedModelRequestJournalLeases(binding, "registry-test", async scope => {
					scope.assertActive();
					expect(scope.ownerId).toBe(input.requesterWriterId);
					entered++;
				});
			});
			expect(entered).toBe(2);
		} finally { input.close(); }
	});

	test("closing the actual registered writer irrevocably invalidates its binding", async () => {
		const input = await fixture();
		try {
			await expect(withVerifiedModelRequestJournalBinding({resources: input.resources, requester: input.requester, mode: "resume", rootSessionId: "root"}, async binding => {
				input.db.close();
				await withVerifiedModelRequestJournalLeases(binding, "registry-test", async () => {});
			})).rejects.toThrow();
		} finally { input.close(); }
	});

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
			const observer = openModelRequestJournalDatabase(input.resources.databasePath, {readonly: true, create: false, strict: true});
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

	test("verified retained root keeps the OS lock until synchronous release, without releasing writer", async () => {
		const input = await fixture();
		const owner = process.getuid?.();
		if (owner === undefined) throw new Error("Missing test uid");
		let retained: ModelRequestJournalRetainedRootScope | undefined;
		try {
			await withVerifiedModelRequestJournalBinding({resources: input.resources, requester: input.requester, mode: "resume", rootSessionId: "root"}, async binding => {
				const namespace = withRawModelRequestJournalLeases({storeId: input.resources.storeId, control: "shared", maintenance: "shared"}, raw => raw.namespacePath);
				retained = retainVerifiedModelRequestJournalRoot(binding, "registry-test");
				expect(retained.ownerId).toBe(input.requesterWriterId);
				retained.assertHeld();
				retained.assertActive();
				const root = join(namespace, "accounting/registry-test.lock");
				expect(tryAcquireRawModelRequestJournalFileLease(root, "exclusive", owner)).toBeUndefined();
				retained.release();
				const immediately = tryAcquireRawModelRequestJournalFileLease(root, "exclusive", owner);
				if (immediately === undefined) throw new Error("Synchronous retained release did not release root");
				immediately.release();
				expect(tryAcquireRawModelRequestJournalFileLease(join(namespace, "owners", `${input.requesterWriterId}.lock`), "exclusive", owner)).toBeUndefined();
				retained.release();
				expect(() => retained?.assertHeld()).toThrow("ended");
				expect(() => retained?.assertActive()).toThrow("ended");
				const next = retainVerifiedModelRequestJournalRoot(binding, "registry-test");
				next.assertActive();
				// Intentionally leave next held: binding finally must close it before owner exit.
				retained = next;
			});
			expect(() => retained?.assertHeld()).toThrow("ended");
			expect(() => retained?.assertActive()).toThrow("ended");
			retained?.release();
		} finally { input.close(); }
	});

	test("binding end releases remaining retained root before owner/control/maintenance exit", async () => {
		const input = await fixture();
		const owner = process.getuid?.();
		if (owner === undefined) throw new Error("Missing test uid");
		let namespace: string | undefined;
		let retained: ModelRequestJournalRetainedRootScope | undefined;
		let savedBinding: ModelRequestJournalLeaseBinding | undefined;
		try {
			await withVerifiedModelRequestJournalBinding({resources: input.resources, requester: input.requester, mode: "resume", rootSessionId: "root"}, async binding => {
				savedBinding = binding;
				namespace = withRawModelRequestJournalLeases({storeId: input.resources.storeId, control: "shared", maintenance: "shared"}, raw => raw.namespacePath);
				retained = retainVerifiedModelRequestJournalRoot(binding, "registry-test");
				retained.assertActive();
				await Promise.resolve();
				retained.assertHeld();
			});
			if (namespace === undefined || savedBinding === undefined) throw new Error("Missing retained binding fixture");
			const endedBinding = savedBinding;
			expect(() => retainVerifiedModelRequestJournalRoot(endedBinding, "registry-test")).toThrow("ended");
			expect(() => retained?.assertHeld()).toThrow("ended");
			for (const path of [
				join(namespace, "accounting/registry-test.lock"),
				join(namespace, "owners", `${input.requesterWriterId}.lock`),
				join(namespace, "maintenance.lock"),
				join(namespace, "control", `${input.resources.storeId}.lock`),
			]) {
				const available = tryAcquireRawModelRequestJournalFileLease(path, "exclusive", owner);
				if (available === undefined) throw new Error("Binding left actual lease held");
				available.release();
			}
		} finally { input.close(); }
	});

	test("retained authority rejects copied bindings, another callback and a root-held callback", async () => {
		const input = await fixture();
		const gate = Promise.withResolvers<void>();
		let saved: ModelRequestJournalLeaseBinding | undefined;
		const request = {resources: input.resources, requester: input.requester, mode: "resume" as const, rootSessionId: "root"};
		const first = withVerifiedModelRequestJournalBinding(request, async binding => {
			saved = binding;
			await gate.promise;
		});
		try {
			if (saved === undefined) throw new Error("Missing first binding");
			const original = saved;
			await withVerifiedModelRequestJournalBinding(request, async binding => {
				expect(() => retainVerifiedModelRequestJournalRoot({...binding}, "registry-test")).toThrow("unverified");
				expect(() => retainVerifiedModelRequestJournalRoot(original, "registry-test")).toThrow("rejected");
				await withVerifiedModelRequestJournalLeases(binding, "registry-test", async scope => {
					expect(scope.ownerId).toBe(input.requesterWriterId);
					expect(() => retainVerifiedModelRequestJournalRoot(binding, "registry-test")).toThrow("order rejected");
				});
				const retained = retainVerifiedModelRequestJournalRoot(binding, "registry-test");
				retained.assertActive();
				retained.release();
			});
		} finally {
			gate.resolve();
			await first;
			input.close();
		}
	});

	test("fixed DB revocation and restored authority records never revive a retained binding", async () => {
		for (const mutation of ["writer", "record"] as const) {
			const input = await fixture();
			let retained: ModelRequestJournalRetainedRootScope | undefined;
			try {
				await expect(withVerifiedModelRequestJournalBinding({resources: input.resources, requester: input.requester, mode: "resume", rootSessionId: "root"}, async binding => {
					retained = retainVerifiedModelRequestJournalRoot(binding, "registry-test");
					if (mutation === "writer") {
						input.db.query("UPDATE writer SET role='cli-tool' WHERE id=?").run(input.requesterWriterId);
						expect(() => retained?.assertActive()).toThrow("requester rejected");
						input.db.query("UPDATE writer SET role='operator-command' WHERE id=?").run(input.requesterWriterId);
					} else {
						const recordPath = withRawModelRequestJournalLeases({storeId: input.resources.storeId, control: "shared", maintenance: "shared"}, raw => raw.recordPath);
						const record = readFileSync(recordPath, "utf8");
						writeFileSync(recordPath, record.replace('"state":"active"', '"state":"held"'));
						expect(() => retained?.assertActive()).toThrow("authority changed");
						writeFileSync(recordPath, record);
					}
					expect(() => retained?.assertActive()).toThrow("ended");
					expect(() => retainVerifiedModelRequestJournalRoot(binding, "other-root")).toThrow("ended");
				})).rejects.toThrow("ended");
				expect(() => retained?.assertHeld()).toThrow("ended");
			} finally { input.close(); }
		}
	});

	test("real retained release failures irreversibly poison the binding and preserve cleanup errors", async () => {
		for (const explicitRelease of [true, false]) {
			const input = await fixture();
			let retained: ModelRequestJournalRetainedRootScope | undefined;
			const bodyFailure = new Error("binding-body-failure");
			let releaseFailure: unknown;
			try {
				let caught: unknown;
				try {
					await withVerifiedModelRequestJournalBinding({resources: input.resources, requester: input.requester, mode: "resume", rootSessionId: "root"}, async binding => {
						const namespace = withRawModelRequestJournalLeases({storeId: input.resources.storeId, control: "shared", maintenance: "shared"}, raw => raw.namespacePath);
						retained = retainVerifiedModelRequestJournalRoot(binding, "registry-test");
						closeActualRootDescriptor(join(namespace, "accounting/registry-test.lock"));
						if (explicitRelease) {
							try { retained.release(); } catch (error) { releaseFailure = error; }
							expect(releaseFailure).toBeInstanceOf(AggregateError);
							retained.release();
							expect(() => retained?.assertHeld()).toThrow("ended");
							expect(() => retainVerifiedModelRequestJournalRoot(binding, "other-root")).toThrow("ended");
							throw releaseFailure;
						}
						throw bodyFailure;
					});
				} catch (error) { caught = error; }
				if (explicitRelease) expect(caught).toBe(releaseFailure);
				else {
					expect(caught).toBeInstanceOf(AggregateError);
					if (!(caught instanceof AggregateError)) throw new Error("Missing combined cleanup failure");
					expect(caught.errors[0]).toBe(bodyFailure);
					expect(caught.errors[1]).toBeInstanceOf(AggregateError);
				}
				expect(() => retained?.assertActive()).toThrow("ended");
				retained?.release();
			} finally { input.close(); }
		}
	});

	test("single binding body error is not wrapped and retirement invalidates retained authority", async () => {
		const input = await fixture();
		const failure = new Error("single-binding-failure");
		let retained: ModelRequestJournalRetainedRootScope | undefined;
		try {
			let caught: unknown;
			try {
				await withVerifiedModelRequestJournalBinding({resources: input.resources, requester: input.requester, mode: "resume", rootSessionId: "root"}, async binding => {
					retained = retainVerifiedModelRequestJournalRoot(binding, "registry-test");
					retireModelRequestWriterCredential(input.requester);
					expect(() => retained?.assertHeld()).toThrow("owner binding rejected");
					expect(() => retainVerifiedModelRequestJournalRoot(binding, "other-root")).toThrow("ended");
					throw failure;
				});
			} catch (error) { caught = error; }
			expect(caught).toBe(failure);
			expect(() => retained?.assertActive()).toThrow("ended");
		} finally { input.close(); }
	});
});
