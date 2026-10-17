import type { Database } from "bun:sqlite";
import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
	beginClosingBindingLifetime,
	finishBindingLifetime,
	initializeBindingLifetime,
	joinBindingPrincipalDrains,
} from "../internal/model-request-journal-binding-lifetime";
import {
	retainRawModelRequestJournalRoot,
	withRawModelRequestJournalLeases,
	type RawModelRequestJournalLeaseScope,
	type RawModelRequestJournalRetainedRootScope,
} from "./model-request-journal-leases";
import {
	assertModelRequestJournalDatabase,
	openModelRequestJournalDatabase,
} from "./model-request-journal-sqlite-control";

export type ModelRequestWriterRole =
	| "model-agent"
	| "harness-core"
	| "harness-runner"
	| "operator-command"
	| "cli-tool";
export interface ModelRequestWriterCredential {
	readonly writerId: string;
	readonly token: Uint8Array;
	readonly role: ModelRequestWriterRole;
	readonly capabilities: readonly string[];
	readonly identity?: Readonly<{
		sessionId: string;
		id: string;
		kind: "main" | "sub";
		depth: number;
		parentId?: string;
	}>;
	readonly parentWriterId?: string;
}
export interface ModelRequestWriterAuthenticationRow {
	readonly id: string;
	readonly role: string;
	readonly capabilitiesJson: string;
	readonly tokenHash: string;
	readonly sessionId: string | null;
	readonly agentId: string | null;
	readonly kind: string | null;
	readonly depth: number | null;
	readonly parentWriterId: string | null;
}
export interface ModelRequestWriterAuthenticationSnapshot {
	readonly writer: ModelRequestWriterAuthenticationRow | undefined;
	readonly inactive: boolean;
}
export type ModelRequestWriterAuthenticationVerdict =
	| Readonly<{ ok: true; row: ModelRequestWriterAuthenticationRow; active: boolean }>
	| Readonly<{ ok: false; reason: "unrecognized" | "retired" | "mismatch" }>;
export interface ModelRequestJournalAuthorityResources {
	readonly storeId: string;
	readonly databasePath: string;
}
const runtimeBrand: unique symbol = Symbol("model-request-journal-authority-runtime");
export const modelRequestJournalAuthorityRuntimeIdentity = Object.freeze({ [runtimeBrand]: true });
const bindingBrand: unique symbol = Symbol("model-request-journal-binding");
export interface ModelRequestJournalLeaseBinding {
	readonly [bindingBrand]: true;
	readonly runtimeIdentity: typeof modelRequestJournalAuthorityRuntimeIdentity;
	readonly rootSessionId: string;
}
export interface ModelRequestJournalRootLeaseScope {
	readonly binding: ModelRequestJournalLeaseBinding;
	readonly runtimeIdentity: typeof modelRequestJournalAuthorityRuntimeIdentity;
	readonly registryId: string;
	readonly rootSessionId: string;
	readonly storeId: string;
	readonly ownerId: string;
	readonly authorityEpoch: number;
	readonly physicalBindingId: string;
	assertActive(): void;
}
const privateRetainedRootBrand: unique symbol = Symbol("model-request-journal-retained-root");
export interface ModelRequestJournalRetainedRootScope extends ModelRequestJournalRootLeaseScope {
	readonly [privateRetainedRootBrand]: true;
	assertHeld(): void;
	release(): void;
}
const BOOTSTRAP_ROLES: readonly ModelRequestWriterRole[] = Object.freeze(["operator-command"]);
const RESUME_ROLES: readonly ModelRequestWriterRole[] = Object.freeze(["operator-command", "harness-core"]);
/** Descriptive values only. The verifier uses the private fixed role definitions. */
export const modelRequestJournalBindingRoles = Object.freeze({
	"bootstrap-new": Object.freeze([...BOOTSTRAP_ROLES]),
	resume: Object.freeze([...RESUME_ROLES]),
});
interface StoredCredential {
	readonly credential: ModelRequestWriterCredential;
	readonly originalToken: Uint8Array;
	readonly tokenHash: string;
	readonly generation: object;
}
const credentials = new WeakMap<object, StoredCredential>();
const retired = new WeakSet<object>();
// Kept for this module execution's entire lifetime: retirement must never permit alias resurrection.
const credentialOwners = new Map<string, object>();
const ROLES: Readonly<Record<string, true>> = Object.freeze({
	"model-agent": true,
	"harness-core": true,
	"harness-runner": true,
	"operator-command": true,
	"cli-tool": true,
});
const tokenByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength")?.get;
const copyTokenBytes = Uint8Array.prototype.set;
const zeroTokenBytes = Uint8Array.prototype.fill;
function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Reflect.ownKeys(value).every(key => typeof key === "string" && keys.includes(key))
	);
}
function text(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 1024;
}
function integer(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function validRole(value: unknown): value is ModelRequestWriterRole {
	return typeof value === "string" && Object.hasOwn(ROLES, value);
}
/** Raw secret retention is not authority: only a later self-opened database match can issue a binding. */
export function retainModelRequestWriterCredential(handle: object, credential: ModelRequestWriterCredential): void {
	if (
		handle === null ||
		typeof handle !== "object" ||
		!closed(credential, ["writerId", "token", "role", "capabilities", "identity", "parentWriterId"])
	)
		throw new Error("Writer credential rejected");
	// Read caller-controlled fields exactly once. Complete normalization before any
	// uniqueness checks: getters may reenter this kernel or change later reads.
	const {
		writerId,
		token: originalToken,
		role,
		capabilities: suppliedCapabilities,
		identity: suppliedIdentity,
		parentWriterId,
	} = credential;
	if (
		!text(writerId) ||
		!validRole(role) ||
		!(originalToken instanceof Uint8Array) ||
		!Array.isArray(suppliedCapabilities) ||
		(parentWriterId !== undefined && !text(parentWriterId))
	)
		throw new Error("Writer credential rejected");
	const capabilityCount: unknown = suppliedCapabilities.length;
	if (
		(capabilityCount !== 0 && capabilityCount !== 1) ||
		Reflect.ownKeys(suppliedCapabilities).some(key => key !== "length" && key !== "0")
	)
		throw new Error("Writer credential rejected");
	const capabilities: string[] = [];
	if (capabilityCount === 1) {
		const capability: unknown = suppliedCapabilities[0];
		if (capability !== "review") throw new Error("Writer credential rejected");
		capabilities.push(capability);
	}
	let identity: ModelRequestWriterCredential["identity"];
	if (suppliedIdentity !== undefined) {
		if (!closed(suppliedIdentity, ["sessionId", "id", "kind", "depth", "parentId"]))
			throw new Error("Writer credential rejected");
		const { sessionId, id, kind, depth, parentId } = suppliedIdentity;
		if (
			!text(sessionId) ||
			!text(id) ||
			(kind !== "main" && kind !== "sub") ||
			!integer(depth) ||
			(parentId !== undefined && !text(parentId))
		)
			throw new Error("Writer credential rejected");
		identity = Object.freeze({ sessionId, id, kind, depth, ...(parentId === undefined ? {} : { parentId }) });
	}
	// Use typed-array intrinsics, not caller length/iterator/species/set overrides.
	if (tokenByteLength === undefined || tokenByteLength.call(originalToken) !== 32)
		throw new Error("Writer credential rejected");
	const token = new Uint8Array(32);
	copyTokenBytes.call(token, originalToken);
	const copy: ModelRequestWriterCredential = Object.freeze({
		writerId,
		role,
		token,
		capabilities: Object.freeze(capabilities),
		...(identity === undefined ? {} : { identity }),
		...(parentWriterId === undefined ? {} : { parentWriterId }),
	});
	let retained = false;
	try {
		const tokenHash = createHash("sha256").update(token).digest("hex");
		const key = `${writerId}:${tokenHash}`;
		if (retired.has(handle) || credentials.has(handle)) throw new Error("Writer credential rejected");
		if (credentialOwners.has(key)) throw new Error("Writer credential alias rejected");
		credentials.set(handle, { credential: copy, originalToken, tokenHash, generation: Object.freeze({}) });
		credentialOwners.set(key, handle);
		retained = true;
	} finally {
		if (!retained) zeroTokenBytes.call(token, 0);
	}
}
export function retireModelRequestWriterCredential(handle: object): void {
	retired.add(handle);
	const stored = credentials.get(handle);
	credentials.delete(handle);
	if (stored === undefined) return;
	try {
		zeroTokenBytes.call(stored.credential.token, 0);
	} finally {
		zeroTokenBytes.call(stored.originalToken, 0);
	}
}
/** Ordinary authentication result. Caller-provided snapshots never affect verified state. */
export function inspectModelRequestWriterCredential(
	handle: object,
	snapshot: ModelRequestWriterAuthenticationSnapshot,
): ModelRequestWriterAuthenticationVerdict {
	if (retired.has(handle)) return Object.freeze({ ok: false, reason: "retired" });
	const stored = credentials.get(handle);
	if (stored === undefined) return Object.freeze({ ok: false, reason: "unrecognized" });
	if (!closed(snapshot, ["writer", "inactive"]) || typeof snapshot.inactive !== "boolean")
		return Object.freeze({ ok: false, reason: "mismatch" });
	const row = snapshot.writer;
	const credential = stored.credential;
	const identity = credential.identity;
	if (
		!closed(row, [
			"id",
			"role",
			"capabilitiesJson",
			"tokenHash",
			"sessionId",
			"agentId",
			"kind",
			"depth",
			"parentWriterId",
		]) ||
		row.id !== credential.writerId ||
		row.role !== credential.role ||
		row.capabilitiesJson !== JSON.stringify(credential.capabilities) ||
		typeof row.tokenHash !== "string" ||
		!/^[0-9a-f]{64}$/.test(row.tokenHash) ||
		!timingSafeEqual(
			Buffer.from(row.tokenHash, "hex"),
			Buffer.from(createHash("sha256").update(credential.token).digest("hex"), "hex"),
		) ||
		row.sessionId !== (identity?.sessionId ?? null) ||
		row.agentId !== (identity?.id ?? null) ||
		row.kind !== (identity?.kind ?? null) ||
		row.depth !== (identity?.depth ?? null) ||
		row.parentWriterId !== (credential.parentWriterId ?? null)
	)
		return Object.freeze({ ok: false, reason: "mismatch" });
	return Object.freeze({ ok: true, row: Object.freeze({ ...row }), active: !snapshot.inactive });
}
interface AuthorityRecord {
	readonly schemaVersion: 1;
	readonly storeId: string;
	readonly authorityEpoch: number;
	readonly physicalBindingId: string;
	readonly dbDevice: number;
	readonly dbInode: number;
	readonly state: "held" | "active";
}
interface BindingState {
	readonly resources: ModelRequestJournalAuthorityResources;
	readonly requester: object;
	readonly mode: "bootstrap-new" | "resume";
	readonly rootSessionId: string;
	readonly generation: object;
	readonly raw: RawModelRequestJournalLeaseScope;
	readonly record: AuthorityRecord;
	readonly retained: Set<ModelRequestJournalRetainedRootScope>;
	open: boolean;
	writerGenerations?: readonly bigint[];
}
const bindings = new WeakMap<object, BindingState>();
interface RetainedRootState {
	readonly binding: ModelRequestJournalLeaseBinding;
	readonly state: BindingState;
	readonly raw: RawModelRequestJournalRetainedRootScope;
	readonly record: AuthorityRecord;
	open: boolean;
}
const retainedRoots = new WeakMap<object, RetainedRootState>();
function ownerIdFor(state: BindingState, raw: RawModelRequestJournalLeaseScope): string {
	const stored = credentials.get(state.requester);
	if (
		stored === undefined ||
		stored.generation !== state.generation ||
		retired.has(state.requester) ||
		raw.ownerId !== stored.credential.writerId ||
		raw.storeId !== state.resources.storeId ||
		state.raw.ownerId !== raw.ownerId
	)
		throw new Error("Journal owner binding rejected");
	return raw.ownerId;
}
function releaseRetainedRoots(state: BindingState): void {
	state.open = false;
	const failures: unknown[] = [];
	for (const retained of state.retained) {
		try {
			retained.release();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, "Journal retained root releases failed");
}
function recordAt(raw: RawModelRequestJournalLeaseScope): AuthorityRecord {
	raw.assertHeld();
	const fd = openSync(raw.recordPath, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = fstatSync(fd);
		const named = lstatSync(raw.recordPath);
		if (
			!stat.isFile() ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & 0o7777) !== 0o600 ||
			stat.nlink !== 1 ||
			stat.dev !== named.dev ||
			stat.ino !== named.ino ||
			stat.size > 4096
		)
			throw new Error("Journal authority record rejected");
		const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
		if (
			!closed(value, [
				"schemaVersion",
				"storeId",
				"authorityEpoch",
				"physicalBindingId",
				"dbDevice",
				"dbInode",
				"state",
			]) ||
			value.schemaVersion !== 1 ||
			value.storeId !== raw.storeId ||
			!integer(value.authorityEpoch) ||
			value.authorityEpoch < 1 ||
			typeof value.physicalBindingId !== "string" ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.physicalBindingId) ||
			!integer(value.dbDevice) ||
			!integer(value.dbInode) ||
			(value.state !== "active" && value.state !== "held")
		)
			throw new Error("Journal authority record rejected");
		return Object.freeze({
			schemaVersion: 1,
			storeId: value.storeId,
			authorityEpoch: value.authorityEpoch,
			physicalBindingId: value.physicalBindingId,
			dbDevice: value.dbDevice,
			dbInode: value.dbInode,
			state: value.state,
		});
	} finally {
		closeSync(fd);
	}
}
const CONTROL_COLUMNS = Object.freeze({
	writer:
		"seq,id,tx_seq,created_at_ms,role,capabilities_json,agent_kind,omp_agent_id,depth,parent_writer_id,omp_session_id,token_hash,host_pid,component_version_id",
	writer_event: "seq,id,tx_seq,created_at_ms,writer_id,event,reason",
	store_config_event: "seq,id,tx_seq,created_at_ms,key,value_json,approval_id,writer_id",
});
function objectRow(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error("Journal control codec rejected");
	return value as Record<string, unknown>;
}
function authenticationRow(value: unknown): ModelRequestWriterAuthenticationRow {
	const row = objectRow(value);
	if (
		!text(row.id) ||
		!validRole(row.role) ||
		typeof row.capabilities_json !== "string" ||
		typeof row.token_hash !== "string" ||
		!/^[0-9a-f]{64}$/.test(row.token_hash) ||
		(row.omp_session_id !== null && !text(row.omp_session_id)) ||
		(row.omp_agent_id !== null && !text(row.omp_agent_id)) ||
		(row.agent_kind !== null && row.agent_kind !== "main" && row.agent_kind !== "sub") ||
		(row.depth !== null && !integer(row.depth)) ||
		(row.parent_writer_id !== null && !text(row.parent_writer_id))
	)
		throw new Error("Journal writer codec rejected");
	const capabilities: unknown = JSON.parse(row.capabilities_json);
	if (
		!Array.isArray(capabilities) ||
		capabilities.length > 1 ||
		capabilities.some(value => value !== "review") ||
		JSON.stringify(capabilities) !== row.capabilities_json
	)
		throw new Error("Journal writer codec rejected");
	return Object.freeze({
		id: row.id,
		role: row.role,
		capabilitiesJson: row.capabilities_json,
		tokenHash: row.token_hash,
		sessionId: row.omp_session_id,
		agentId: row.omp_agent_id,
		kind: row.agent_kind,
		depth: row.depth,
		parentWriterId: row.parent_writer_id,
	});
}
function controlSnapshot(
	db: Database,
	storeId: string,
	requesterId: string,
	record: AuthorityRecord,
): ModelRequestWriterAuthenticationSnapshot {
	if (
		objectRow(db.query("PRAGMA application_id").get()).application_id !== 0x4f534155 ||
		objectRow(db.query("PRAGMA user_version").get()).user_version !== 20 ||
		objectRow(db.query("SELECT store_id FROM store_meta WHERE singleton=1").get()).store_id !== storeId
	)
		throw new Error("Journal database schema rejected");
	for (const [table, columns] of Object.entries(CONTROL_COLUMNS)) {
		// All identifiers here are module-private literals, never caller input.
		const definitions = db.query(`PRAGMA table_info(${table})`).all().map(objectRow);
		const actual = definitions.map(value => value.name);
		for (const [index, definition] of definitions.entries()) {
			const name = definition.name;
			if (typeof name !== "string") throw new Error("Journal control schema rejected");
			const numeric = ["seq", "tx_seq", "created_at_ms", "depth", "host_pid"].includes(name);
			const nullable = [
				"seq",
				"agent_kind",
				"omp_agent_id",
				"depth",
				"parent_writer_id",
				"omp_session_id",
				"host_pid",
				"component_version_id",
				"reason",
				"approval_id",
			].includes(name);
			if (
				definition.cid !== index ||
				definition.type !== (numeric ? "INTEGER" : "TEXT") ||
				definition.notnull !== (nullable ? 0 : 1) ||
				definition.pk !== (name === "seq" ? 1 : 0) ||
				definition.dflt_value !== null
			)
				throw new Error("Journal control schema rejected");
		}
		const info = db
			.query("SELECT strict FROM pragma_table_list WHERE schema='main' AND name=? AND type='table'")
			.get(table);
		if (actual.join(",") !== columns || objectRow(info).strict !== 1)
			throw new Error("Journal control schema rejected");
	}
	const writers = new Map<string, { row: ModelRequestWriterAuthenticationRow; txSeq: number }>();
	let writerSeq = 0;
	let writerTx = 0;
	for (const value of db
		.query("SELECT w.*,t.sealed FROM writer w LEFT JOIN tx_log t ON t.tx_seq=w.tx_seq ORDER BY w.seq")
		.all()) {
		const raw = objectRow(value);
		const row = authenticationRow(raw);
		if (
			!integer(raw.seq) ||
			raw.seq <= writerSeq ||
			!integer(raw.tx_seq) ||
			raw.tx_seq < writerTx ||
			raw.sealed !== 1 ||
			!integer(raw.created_at_ms) ||
			writers.has(row.id)
		)
			throw new Error("Journal writer order rejected");
		writerSeq = raw.seq;
		writerTx = raw.tx_seq;
		writers.set(row.id, { row, txSeq: raw.tx_seq });
	}
	const inactive = new Map<string, number>();
	let lastSeq = 0;
	let lastTx = 0;
	for (const value of db
		.query(
			"SELECT e.*,t.writer_id AS tx_writer_id,t.sealed FROM writer_event e LEFT JOIN tx_log t ON t.tx_seq=e.tx_seq ORDER BY e.seq",
		)
		.all()) {
		const row = objectRow(value);
		const writer = typeof row.writer_id === "string" ? writers.get(row.writer_id) : undefined;
		if (
			!integer(row.seq) ||
			row.seq <= lastSeq ||
			!integer(row.tx_seq) ||
			row.tx_seq < lastTx ||
			writer === undefined ||
			writer.txSeq >= row.tx_seq ||
			(row.event !== "ended" && row.event !== "revoked") ||
			row.sealed !== 1 ||
			!text(row.id) ||
			(row.reason !== null && typeof row.reason !== "string")
		)
			throw new Error("Journal writer event rejected");
		const actor = typeof row.tx_writer_id === "string" ? writers.get(row.tx_writer_id) : undefined;
		if (
			actor === undefined ||
			actor.txSeq > row.tx_seq ||
			inactive.has(actor.row.id) ||
			(row.event === "ended" && row.tx_writer_id !== row.writer_id) ||
			(row.event === "revoked" && actor.row.role !== "operator-command" && actor.row.role !== "harness-core")
		)
			throw new Error("Journal writer event attribution rejected");
		if (!inactive.has(writer.row.id)) inactive.set(writer.row.id, row.tx_seq);
		lastSeq = row.seq;
		lastTx = row.tx_seq;
	}
	let latest: Record<string, unknown> | undefined;
	lastSeq = 0;
	lastTx = 0;
	let lastEpoch = 0;
	for (const value of db
		.query(
			"SELECT e.*,t.writer_id AS tx_writer_id,t.op_name,t.sealed FROM store_config_event e LEFT JOIN tx_log t ON t.tx_seq=e.tx_seq WHERE e.key='budget_authority_epoch' ORDER BY e.seq",
		)
		.all()) {
		const row = objectRow(value);
		const writer = typeof row.writer_id === "string" ? writers.get(row.writer_id) : undefined;
		if (
			!integer(row.seq) ||
			row.seq <= lastSeq ||
			!integer(row.tx_seq) ||
			row.tx_seq < lastTx ||
			writer === undefined ||
			writer.txSeq > row.tx_seq ||
			writer.row.role !== "operator-command" ||
			row.tx_writer_id !== row.writer_id ||
			row.sealed !== 1 ||
			row.op_name !== "bootstrapModelRequestJournalAuthority" ||
			typeof row.value_json !== "string" ||
			row.approval_id !== null ||
			!text(row.id) ||
			!integer(row.created_at_ms)
		)
			throw new Error("Journal epoch attribution rejected");
		const inactiveAt = inactive.get(writer.row.id);
		if (inactiveAt !== undefined && inactiveAt <= row.tx_seq) throw new Error("Journal epoch writer inactive");
		const epoch: unknown = JSON.parse(row.value_json);
		if (
			!closed(epoch, ["schemaVersion", "authorityEpoch", "physicalBindingId"]) ||
			epoch.schemaVersion !== 1 ||
			!integer(epoch.authorityEpoch) ||
			epoch.authorityEpoch <= lastEpoch ||
			!text(epoch.physicalBindingId)
		)
			throw new Error("Journal epoch codec rejected");
		latest = epoch;
		lastSeq = row.seq;
		lastTx = row.tx_seq;
		lastEpoch = epoch.authorityEpoch;
	}
	if (
		latest === undefined ||
		latest.authorityEpoch !== record.authorityEpoch ||
		latest.physicalBindingId !== record.physicalBindingId
	)
		throw new Error("Journal epoch mismatch");
	return Object.freeze({ writer: writers.get(requesterId)?.row, inactive: inactive.has(requesterId) });
}
function verify(state: BindingState): AuthorityRecord {
	let db: Database | undefined;
	let failure: unknown;
	let failed = false;
	try {
		if (
			!state.open ||
			credentials.get(state.requester)?.generation !== state.generation ||
			retired.has(state.requester)
		)
			throw new Error("Journal binding ended");
		state.raw.assertHeld();
		ownerIdFor(state, state.raw);
		const record = recordAt(state.raw);
		if (record.state !== "active" || JSON.stringify(record) !== JSON.stringify(state.record))
			throw new Error("Journal authority changed");
		// The factory owns this real RO connection. Pathname fds and caller connections are not evidence.
		db = openModelRequestJournalDatabase(state.resources.databasePath, {
			readonly: true,
			create: false,
			strict: true,
			safeIntegers: false,
			purpose: "authority-control",
		});
		const initial = assertModelRequestJournalDatabase(db);
		if (
			initial.device !== record.dbDevice ||
			initial.inode !== record.dbInode ||
			initial.liveWriterGenerations.length === 0
		)
			throw new Error("Journal database identity rejected");
		db.exec("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; BEGIN");
		const credential = credentials.get(state.requester);
		if (credential === undefined) throw new Error("Journal requester unsupported");
		const snapshot = controlSnapshot(db, state.resources.storeId, credential.credential.writerId, record);
		// BEGIN alone is not a snapshot: the fixed SELECTs above must have entered a real read transaction.
		const actual = assertModelRequestJournalDatabase(db);
		if (
			actual.transactionState !== 1 ||
			actual.transactionGeneration === 0n ||
			actual.connectionGeneration !== initial.connectionGeneration ||
			actual.device !== record.dbDevice ||
			actual.inode !== record.dbInode ||
			actual.liveWriterGenerations.length !== initial.liveWriterGenerations.length ||
			actual.liveWriterGenerations.some((generation, index) => generation !== initial.liveWriterGenerations[index])
		)
			throw new Error("Journal database snapshot rejected");
		if (state.writerGenerations === undefined) state.writerGenerations = actual.liveWriterGenerations;
		else if (
			state.writerGenerations.length !== actual.liveWriterGenerations.length ||
			state.writerGenerations.some((generation, index) => generation !== actual.liveWriterGenerations[index])
		)
			throw new Error("Journal live writer generation changed");
		const verdict = inspectModelRequestWriterCredential(state.requester, snapshot);
		const allowed = state.mode === "bootstrap-new" ? BOOTSTRAP_ROLES : RESUME_ROLES;
		if (
			!verdict.ok ||
			!verdict.active ||
			!validRole(verdict.row.role) ||
			!allowed.includes(verdict.row.role) ||
			(verdict.row.sessionId !== null && verdict.row.sessionId !== state.rootSessionId)
		)
			throw new Error("Journal requester rejected");
		const final = assertModelRequestJournalDatabase(db);
		if (
			final.transactionGeneration !== actual.transactionGeneration ||
			final.transactionState !== 1 ||
			JSON.stringify(recordAt(state.raw)) !== JSON.stringify(record)
		)
			throw new Error("Journal authority snapshot changed");
		db.exec("ROLLBACK");
		return record;
	} catch (error) {
		failed = true;
		failure = error;
		state.open = false;
		throw error;
	} finally {
		try {
			db?.close();
		} catch (error) {
			state.open = false;
			if (failed) throw new AggregateError([failure, error], "Journal verification and connection close failed");
			throw error;
		}
	}
}
export async function withVerifiedModelRequestJournalBinding<T>(
	request: Readonly<{
		resources: ModelRequestJournalAuthorityResources;
		requester: object;
		mode: "bootstrap-new" | "resume";
		rootSessionId: string;
	}>,
	use: (binding: ModelRequestJournalLeaseBinding) => Promise<T>,
): Promise<T> {
	if (
		!closed(request, ["resources", "requester", "mode", "rootSessionId"]) ||
		!closed(request.resources, ["storeId", "databasePath"]) ||
		!text(request.resources.storeId) ||
		!text(request.resources.databasePath) ||
		!isAbsolute(request.resources.databasePath) ||
		request.requester === null ||
		typeof request.requester !== "object" ||
		(request.mode !== "bootstrap-new" && request.mode !== "resume") ||
		!text(request.rootSessionId)
	)
		throw new Error("Journal binding request rejected");
	const stored = credentials.get(request.requester);
	if (stored === undefined || retired.has(request.requester)) throw new Error("Journal requester unsupported");
	const resources: ModelRequestJournalAuthorityResources = Object.freeze({ ...request.resources });
	return withRawModelRequestJournalLeases(
		{ storeId: resources.storeId, control: "shared", maintenance: "shared", ownerId: stored.credential.writerId },
		async raw => {
			const state: BindingState = {
				resources,
				requester: request.requester,
				mode: request.mode,
				rootSessionId: request.rootSessionId,
				generation: stored.generation,
				raw,
				record: recordAt(raw),
				retained: new Set(),
				open: true,
			};
			let binding: ModelRequestJournalLeaseBinding | undefined;
			const failures: unknown[] = [];
			try {
				verify(state);
				const verifiedBinding = Object.freeze<ModelRequestJournalLeaseBinding>({
					[bindingBrand]: true,
					runtimeIdentity: modelRequestJournalAuthorityRuntimeIdentity,
					rootSessionId: request.rootSessionId,
				});
				bindings.set(verifiedBinding, state);
				initializeBindingLifetime(verifiedBinding);
				binding = verifiedBinding;
				const result = await use(verifiedBinding);
				verify(state);
				return result;
			} catch (error) {
				failures.push(error);
				throw error;
			} finally {
				if (binding !== undefined) {
					try {
						beginClosingBindingLifetime(binding);
					} catch (error) {
						failures.push(error);
					}
					// Keep genuine authority and the outer native leases alive for accepted
					// continuations and logical close; closing rejects new work privately.
					try {
						await joinBindingPrincipalDrains(binding);
					} catch (error) {
						failures.push(error);
					}
				}
				try {
					releaseRetainedRoots(state);
				} catch (error) {
					failures.push(error);
				}
				if (binding !== undefined) {
					try {
						finishBindingLifetime(binding);
					} catch (error) {
						failures.push(error);
					}
				}
				if (failures.length === 1) throw failures[0];
				if (failures.length > 1) throw new AggregateError(failures, "Journal binding operation and cleanup failed");
			}
		},
	);
}
export async function withVerifiedModelRequestJournalLeases<T>(
	binding: ModelRequestJournalLeaseBinding,
	registryId: string,
	use: (scope: ModelRequestJournalRootLeaseScope) => Promise<T>,
): Promise<T> {
	const state = bindings.get(binding);
	if (
		state === undefined ||
		binding.runtimeIdentity !== modelRequestJournalAuthorityRuntimeIdentity ||
		!text(registryId)
	)
		throw new Error("Journal binding unverified");
	return withRawModelRequestJournalLeases(
		{
			storeId: state.resources.storeId,
			control: "shared",
			maintenance: "shared",
			ownerId: credentials.get(state.requester)?.credential.writerId,
			registryId,
		},
		async raw => {
			let open = true;
			const assertActive = (): void => {
				if (!open) throw new Error("Journal root scope ended");
				raw.assertHeld();
				verify(state);
			};
			try {
				const record = verify(state);
				const scope: ModelRequestJournalRootLeaseScope = Object.freeze({
					binding,
					runtimeIdentity: modelRequestJournalAuthorityRuntimeIdentity,
					registryId,
					rootSessionId: state.rootSessionId,
					storeId: state.resources.storeId,
					ownerId: ownerIdFor(state, raw),
					authorityEpoch: record.authorityEpoch,
					physicalBindingId: record.physicalBindingId,
					assertActive,
				});
				const result = await use(scope);
				assertActive();
				return result;
			} catch (error) {
				state.open = false;
				throw error;
			} finally {
				open = false;
			}
		},
	);
}

/** Retain only the real owner scope already authenticated by this binding. */
export function retainVerifiedModelRequestJournalRoot(
	binding: ModelRequestJournalLeaseBinding,
	registryId: string,
): ModelRequestJournalRetainedRootScope {
	const state = bindings.get(binding);
	if (
		state === undefined ||
		binding.runtimeIdentity !== modelRequestJournalAuthorityRuntimeIdentity ||
		!text(registryId)
	)
		throw new Error("Journal binding unverified");
	const record = verify(state);
	const ownerId = ownerIdFor(state, state.raw);
	const raw = retainRawModelRequestJournalRoot(state.raw, registryId);
	const retained: RetainedRootState = { binding, state, raw, record, open: true };
	const assertHeld = (): void => {
		if (
			!retained.open ||
			!state.open ||
			bindings.get(binding) !== state ||
			retainedRoots.get(scope) !== retained ||
			retained.binding !== binding ||
			retained.state !== state ||
			retained.record.authorityEpoch !== state.record.authorityEpoch ||
			retained.record.physicalBindingId !== state.record.physicalBindingId
		)
			throw new Error("Journal retained root ended");
		state.raw.assertHeld();
		raw.assertHeld();
		if (
			ownerIdFor(state, raw) !== ownerId ||
			raw.registryId !== registryId ||
			raw.storeId !== state.resources.storeId
		)
			throw new Error("Journal retained root binding rejected");
	};
	const scope = Object.freeze<ModelRequestJournalRetainedRootScope>({
		[privateRetainedRootBrand]: true,
		binding,
		runtimeIdentity: modelRequestJournalAuthorityRuntimeIdentity,
		registryId,
		rootSessionId: state.rootSessionId,
		storeId: state.resources.storeId,
		ownerId,
		authorityEpoch: record.authorityEpoch,
		physicalBindingId: record.physicalBindingId,
		assertHeld,
		assertActive() {
			assertHeld();
			verify(state);
			assertHeld();
		},
		release() {
			if (!retained.open) return;
			retained.open = false;
			state.retained.delete(scope);
			try {
				raw.release();
			} catch (error) {
				state.open = false;
				throw error;
			}
		},
	});
	retainedRoots.set(scope, retained);
	state.retained.add(scope);
	return scope;
}
