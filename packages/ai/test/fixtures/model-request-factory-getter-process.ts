import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getModelRequestRuntime } from "../../src/model-request-runtime";
import { transportFetch } from "../../src/utils/transport-fetch";
import { loopbackModel } from "../helpers/model-request-loopback";
import { retainModelRequestWriterCredential, retireModelRequestWriterCredential, withVerifiedModelRequestJournalBinding } from "@oh-my-pi/pi-utils/model-request-journal-authority";
import { withRawModelRequestJournalLeases } from "@oh-my-pi/pi-utils/model-request-journal-leases";
import { openModelRequestJournalDatabase } from "@oh-my-pi/pi-utils/model-request-journal-sqlite-control";
import type { ModelRequestExecution } from "@oh-my-pi/pi-utils/model-request-journal-composition";

const runtime = getModelRequestRuntime();
const model = loopbackModel("openai-completions", "http://127.0.0.1:9");
function constructWithGetter(execution?: ModelRequestExecution): object {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
	if (descriptor === undefined || typeof descriptor.value !== "function") throw new Error("initial builtin fetch descriptor missing");
	const builtin = descriptor.value;
	let getterCalls = 0;
	let constructed = false;
	let error: string | undefined;
	const construct = () => {
		try { transportFetch(model, undefined); constructed = true; }
		catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
	};
	Object.defineProperty(globalThis, "fetch", { configurable: true, get() { getterCalls++; return builtin; } });
	try {
		if (execution === undefined) construct();
		else runtime.runWith(execution, construct);
	} finally { Object.defineProperty(globalThis, "fetch", descriptor); }
	return { journalState: execution?.journalState ?? "untracked", getterCalls, constructed, error };
}

if (process.argv[2] === "untracked") {
	console.log(JSON.stringify(constructWithGetter()));
} else if (process.argv[2] === "required") {
	// Build before the monotonic requirement latch, then call it under the genuine pending execution below.
	let senderCalls = 0;
	const previouslyUntracked = transportFetch(model, async () => {
		senderCalls++;
		throw new Error("a pending execution must never invoke this sender");
	});
	const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "d37-factory-regression-")));
	const storeId = `test-${randomUUID()}`;
	const databasePath = path.join(directory, "state.sqlite3");
	fs.writeFileSync(databasePath, "", { mode: 0o600 });
	const database = openModelRequestJournalDatabase(databasePath, { strict: true, safeIntegers: false });
	fs.chmodSync(databasePath, 0o600);
	const writerId = `writer-${randomUUID()}`;
	const epochWriterId = `writer-${randomUUID()}`;
	const requester = Object.freeze({ writerId });
	const token = randomBytes(32);
	const physicalBindingId = randomUUID();
	retainModelRequestWriterCredential(requester, { writerId, token, role: "operator-command", capabilities: [] });
	let namespace: string | undefined;
	try {
		// Same real owned-database fixture as model-request-journal-authority-sqlite.test.ts;
		// binding issuance still performs the native descriptor, schema, credential and epoch checks.
		const common = "seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,tx_seq INTEGER NOT NULL,created_at_ms INTEGER NOT NULL";
		database.exec(`PRAGMA journal_mode=WAL; PRAGMA application_id=1330856277; PRAGMA user_version=20;
CREATE TABLE store_meta(singleton INTEGER PRIMARY KEY,store_id TEXT) STRICT;
CREATE TABLE tx_log(tx_seq INTEGER PRIMARY KEY,writer_id TEXT,op_name TEXT,sealed INTEGER) STRICT;
CREATE TABLE writer(${common},role TEXT NOT NULL,capabilities_json TEXT NOT NULL,agent_kind TEXT,omp_agent_id TEXT,depth INTEGER,parent_writer_id TEXT,omp_session_id TEXT,token_hash TEXT NOT NULL,host_pid INTEGER,component_version_id TEXT) STRICT;
CREATE TABLE writer_event(${common},writer_id TEXT NOT NULL,event TEXT NOT NULL,reason TEXT) STRICT;
CREATE TABLE store_config_event(${common},key TEXT NOT NULL,value_json TEXT NOT NULL,approval_id TEXT,writer_id TEXT NOT NULL) STRICT;`);
		database.query("INSERT INTO store_meta VALUES(1,?)").run(storeId);
		database.query("INSERT INTO tx_log VALUES(1,?,'store.init',1),(2,?,'bootstrapModelRequestJournalAuthority',1),(3,?,'registerWriter',1)").run(epochWriterId, epochWriterId, epochWriterId);
		database.query("INSERT INTO writer(id,tx_seq,created_at_ms,role,capabilities_json,token_hash) VALUES(?,1,1,'operator-command','[]',?),(?,3,3,'operator-command','[]',?)").run(epochWriterId, createHash("sha256").update(randomBytes(32)).digest("hex"), writerId, createHash("sha256").update(token).digest("hex"));
		database.query("INSERT INTO store_config_event(id,tx_seq,created_at_ms,key,value_json,approval_id,writer_id) VALUES('epoch-1',2,2,'budget_authority_epoch',?,NULL,?)").run(JSON.stringify({ schemaVersion: 1, authorityEpoch: 1, physicalBindingId }), epochWriterId);
		await withRawModelRequestJournalLeases({ storeId, control: "exclusive", maintenance: "exclusive" }, async raw => {
			namespace = raw.namespacePath;
			const stat = fs.statSync(databasePath);
			fs.writeFileSync(raw.recordPath, JSON.stringify({ schemaVersion: 1, storeId, authorityEpoch: 1, physicalBindingId, dbDevice: stat.dev, dbInode: stat.ino, state: "active" }), { mode: 0o600 });
		});
		await withVerifiedModelRequestJournalBinding({ resources: { storeId, databasePath }, requester, mode: "resume", rootSessionId: "d37-getter-root" }, async binding => {
			const execution = runtime.createSessionExecution({
				sessionId: () => "d37-getter-root",
				root: { kind: "self", modelRequestJournalLeaseBinding: binding },
				agent: { id: "d37-getter-agent", name: "main", kind: "main", depth: 0 },
				purpose: "main",
			});
			const factory = constructWithGetter(execution);
			let invocationRejected = false;
			await runtime.runWith(execution, async () => {
				try { await previouslyUntracked("http://127.0.0.1:9"); }
				catch { invocationRejected = true; }
			});
			console.log(JSON.stringify({ factory, previouslyUntracked: { senderCalls, invocationRejected } }));
		});
	} finally {
		retireModelRequestWriterCredential(requester);
		database.close();
		fs.rmSync(directory, { recursive: true, force: true });
		if (namespace !== undefined) fs.rmSync(namespace, { recursive: true, force: true });
	}
} else {
	throw new Error("expected untracked or required scenario");
}
