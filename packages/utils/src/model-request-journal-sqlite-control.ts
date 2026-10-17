import { dlopen, FFIType, ptr, read } from "bun:ffi";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** The only application codec for the source-owned unix VFS control. No caller buffers or expected identities. */
const OPCODE = 0x4f4d5001;
const MAGIC = 0x4f4d5053;
const WORDS = 64;
const VERSION = 1;
const fileControl = Database.prototype.fileControl;
const closeDatabase = Database.prototype.close;
const states = new WeakMap<Database, ConnectionState>();
const writers = new Map<string, Set<WeakRef<ConnectionState>>>();
declare const initializationBrand: unique symbol;
export interface ModelRequestJournalDatabaseInitialization {
	readonly [initializationBrand]: true;
}
export interface ModelRequestJournalDatabaseOptions {
	readonly readonly?: boolean;
	readonly create?: boolean;
	readonly strict?: boolean;
	readonly safeIntegers?: boolean;
}
export interface ModelRequestJournalDatabaseIdentity {
	readonly device: number;
	readonly inode: number;
}
export interface ModelRequestJournalDatabaseInspection extends ModelRequestJournalDatabaseIdentity {
	readonly connectionGeneration: bigint;
	readonly transactionGeneration: bigint;
	readonly transactionState: number;
	readonly liveWriterGenerations: readonly bigint[];
}
export interface ModelRequestJournalCreatedDatabase {
	readonly database: Database;
	readonly storeId: string;
	/** Undefined on the ordinary non-custom runtime; never substitute the creation fd's stat. */
	readonly identity: ModelRequestJournalDatabaseIdentity | undefined;
	readonly initialization: ModelRequestJournalDatabaseInitialization;
}
interface OwnedFile {
	readonly presence: number;
	readonly generation: bigint;
	readonly device: number;
	readonly inode: number;
}
interface ControlResult {
	readonly connectionGeneration: bigint;
	readonly transactionGeneration: bigint;
	readonly transactionState: number;
	readonly main: OwnedFile;
}
interface ConnectionState {
	readonly database: Database;
	readonly filename: string;
	readonly readonly: boolean;
	readonly initial: ControlResult;
	closed: boolean;
}
let directoryRuntime: Readonly<{openAt(parent: number, name: string, flags: number, mode: number): number}> | undefined;
function openAt(parent: number, name: string, flags: number, mode: number): number {
	if (directoryRuntime === undefined) {
		const library = dlopen("/usr/lib/libSystem.B.dylib", {
			openat: {args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.u32], returns: FFIType.i32},
			__error: {args: [], returns: FFIType.ptr},
		});
		directoryRuntime = Object.freeze({openAt(directory: number, component: string, openFlags: number, permissions: number) {
			const encoded = Buffer.from(`${component}\0`);
			const fd = library.symbols.openat(directory, ptr(encoded), openFlags, permissions);
			if (fd >= 0) return fd;
			const address = library.symbols.__error();
			const errno = address === null ? undefined : read.i32(address);
			throw Object.assign(new Error("Journal SQLite native exclusive creation failed"), {code: errno === 17 ? "EEXIST" : "E_NATIVE_CREATE", errno});
		}});
	}
	return directoryRuntime.openAt(parent, name, flags, mode);
}
function uint64(buffer: Uint32Array, at: number): bigint {
	return BigInt(buffer[at]!) | BigInt(buffer[at + 1]!) << 32n;
}
function safeInteger(value: bigint): number {
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number < 0) throw new Error("Journal SQLite identity range rejected");
	return number;
}
function file(buffer: Uint32Array, at: number, main: boolean): OwnedFile {
	const presence = buffer[at]!;
	const generation = uint64(buffer, at + 1);
	const device = safeInteger(uint64(buffer, at + 3));
	const inode = safeInteger(uint64(buffer, at + 5));
	if (presence !== 0 && presence !== 1 && presence !== 2 || main && presence !== 1) throw new Error("Journal SQLite file state rejected");
	if (presence === 1 && (generation === 0n || buffer[at + 7] !== process.getuid?.() || (buffer[at + 8]! & 0o7777) !== 0o600 || buffer[at + 9] !== 1)) throw new Error("Journal SQLite owned file rejected");
	for (let index = at + 10; index < at + 16; index++) if (buffer[index] !== 0) throw new Error("Journal SQLite control reserved field rejected");
	return Object.freeze({presence, generation, device, inode});
}
function control(database: Database, command: 1 | 2 | 3, expected?: ModelRequestJournalDatabaseIdentity): ControlResult | undefined {
	const buffer = new Uint32Array(WORDS);
	buffer[0] = MAGIC;
	buffer[1] = VERSION;
	buffer[2] = WORDS * Uint32Array.BYTES_PER_ELEMENT;
	buffer[3] = command;
	if (expected !== undefined) {
		const device = BigInt(expected.device);
		const inode = BigInt(expected.inode);
		buffer[12] = Number(device & 0xffffffffn);
		buffer[13] = Number(device >> 32n);
		buffer[14] = Number(inode & 0xffffffffn);
		buffer[15] = Number(inode >> 32n);
	}
	const rc = fileControl.call(database, "main", OPCODE, buffer);
	// SQLITE_NOTFOUND is ordinary Bun/system SQLite, not an authentication result.
	if (rc === 12 && command === 1) return undefined;
	if (rc !== 0 || buffer[0] !== MAGIC || buffer[1] !== VERSION || buffer[2] !== WORDS * 4 || buffer[3] !== command || buffer[4] !== 0 || buffer[5] !== 1 || buffer[11] !== 0) throw new Error(`Journal SQLite control rejected (${rc})`);
	for (let index = 12; index < 16; index++) if (buffer[index] !== 0) throw new Error("Journal SQLite control reserved field rejected");
	const connectionGeneration = uint64(buffer, 6);
	const transactionGeneration = uint64(buffer, 8);
	const transactionState = buffer[10]!;
	if (connectionGeneration === 0n || transactionState > 2) throw new Error("Journal SQLite generation rejected");
	const main = file(buffer, 16, true);
	file(buffer, 32, false);
	file(buffer, 48, false);
	return Object.freeze({connectionGeneration, transactionGeneration, transactionState, main});
}
function live(state: ConnectionState): ControlResult {
	if (state.closed) throw new Error("Journal SQLite connection ended");
	try {
		const actual = control(state.database, 1);
		if (actual === undefined || actual.connectionGeneration !== state.initial.connectionGeneration || actual.main.generation !== state.initial.main.generation || actual.main.device !== state.initial.main.device || actual.main.inode !== state.initial.main.inode) throw new Error("Journal SQLite connection changed");
		return actual;
	} catch (error) {
		state.closed = true;
		throw error;
	}
}
function optionsOf(options: ModelRequestJournalDatabaseOptions): ModelRequestJournalDatabaseOptions {
	if (options === null || typeof options !== "object" || Reflect.ownKeys(options).some(key => typeof key !== "string" || !["readonly", "create", "strict", "safeIntegers"].includes(key))) throw new Error("Journal SQLite options rejected");
	const {readonly, create, strict, safeIntegers} = options;
	for (const value of [readonly, create, strict, safeIntegers]) if (value !== undefined && typeof value !== "boolean") throw new Error("Journal SQLite options rejected");
	if (readonly && create) throw new Error("Journal SQLite options rejected");
	return {readonly, create, strict, safeIntegers};
}
/** Ordinary runtimes retain Bun behavior. Managed diagnostics always require the fixed native control. */
export function openModelRequestJournalDatabase(filename: string, options: ModelRequestJournalDatabaseOptions = {}): Database {
	if (typeof filename !== "string" || filename.length === 0 || filename.includes("\0") || filename.startsWith("file:")) throw new Error("Journal SQLite filename rejected");
	const normalized = optionsOf(options);
	const database = new Database(filename, normalized);
	try {
		// A memory-only version probe has no unix file and can never be authority evidence.
		if (filename === ":memory:") return database;
		const initial = control(database, 1);
		if (initial === undefined) {
			if (Reflect.get(globalThis, Symbol.for("omp.audit.sqlite.required.v1")) === true) throw new Error("Journal audit SQLite control unavailable");
			return database;
		}
		const armed = control(database, 2, {device: initial.main.device, inode: initial.main.inode});
		if (armed === undefined || armed.connectionGeneration !== initial.connectionGeneration) throw new Error("Journal SQLite arm rejected");
		if (normalized.readonly) control(database, 3);
		const state: ConnectionState = {database, filename: path.resolve(filename), readonly: normalized.readonly === true, initial: armed, closed: false};
		states.set(database, state);
		let references: Set<WeakRef<ConnectionState>> | undefined;
		let reference: WeakRef<ConnectionState> | undefined;
		if (!state.readonly) {
			references = writers.get(state.filename);
			if (references === undefined) writers.set(state.filename, references = new Set());
			reference = new WeakRef(state);
			references.add(reference);
		}
		Object.defineProperty(database, "close", {configurable: false, writable: false, value(throwOnError?: boolean) {
			try { return closeDatabase.call(database, throwOnError); }
			finally {
				state.closed = true;
				if (reference !== undefined) references?.delete(reference);
				if (references?.size === 0) writers.delete(state.filename);
			}
		}});
		return database;
	} catch (error) {
		try { closeDatabase.call(database); } catch (closeError) { throw new AggregateError([error, closeError], "Journal SQLite open and close failed"); }
		throw error;
	}
}
/** Registered owned-descriptor identity only; never role, bootstrap, epoch or journal readiness authorization. */
export function assertModelRequestJournalDatabase(database: Database): ModelRequestJournalDatabaseInspection {
	const state = states.get(database);
	if (state === undefined) throw new Error("Journal SQLite connection unregistered");
	const actual = live(state);
	const generations: bigint[] = [];
	const references = writers.get(state.filename);
	if (references !== undefined) for (const reference of references) {
		const writer = reference.deref();
		if (writer === undefined || writer.closed) { references.delete(reference); continue; }
		const owned = live(writer);
		if (owned.main.device !== actual.main.device || owned.main.inode !== actual.main.inode) throw new Error("Journal SQLite live writer identity rejected");
		generations.push(owned.connectionGeneration);
	}
	generations.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
	return Object.freeze({device: actual.main.device, inode: actual.main.inode, connectionGeneration: actual.connectionGeneration, transactionGeneration: actual.transactionGeneration, transactionState: actual.transactionState, liveWriterGenerations: Object.freeze(generations)});
}
/** Exclusive creation is not authority. Store's private initializer must authenticate and durably finish all phases. */
export function createModelRequestJournalDatabase(databasePath: string): ModelRequestJournalCreatedDatabase {
	if (typeof databasePath !== "string" || !path.isAbsolute(databasePath) || path.resolve(databasePath) !== databasePath || path.basename(databasePath) !== "state.sqlite3") throw new Error("Journal SQLite new path rejected");
	const directory = path.dirname(databasePath);
	const directoryFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
	let directoryFd = fs.openSync(path.parse(directory).root, directoryFlags);
	let created: fs.Stats;
	const storeId = randomBytes(16).toString("hex");
	const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
	try {
		// Darwin openat walks actual directory handles; a pathname swap cannot redirect exclusive creation.
		if (process.platform === "darwin") for (const component of directory.split("/").filter(Boolean)) {
			const next = openAt(directoryFd, component, directoryFlags, 0);
			fs.closeSync(directoryFd);
			directoryFd = next;
		}
		else {
			fs.closeSync(directoryFd);
			directoryFd = fs.openSync(directory, directoryFlags);
		}
		const parent = fs.fstatSync(directoryFd);
		if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o7777) !== 0o700) throw new Error("Journal SQLite new directory rejected");
		const idFd = process.platform === "darwin" ? openAt(directoryFd, "STORE_ID", flags, 0o600) : fs.openSync(path.join(directory, "STORE_ID"), flags, 0o600);
		try { fs.fchmodSync(idFd, 0o600); fs.writeFileSync(idFd, storeId); fs.fsyncSync(idFd); }
		finally { fs.closeSync(idFd); }
		const fd = process.platform === "darwin" ? openAt(directoryFd, "state.sqlite3", flags, 0o600) : fs.openSync(databasePath, flags, 0o600);
		try { fs.fchmodSync(fd, 0o600); created = fs.fstatSync(fd); fs.fsyncSync(fd); }
		finally { fs.closeSync(fd); }
		fs.fsyncSync(directoryFd);
		const named = fs.lstatSync(directory);
		if (!named.isDirectory() || named.isSymbolicLink() || named.dev !== parent.dev || named.ino !== parent.ino) throw new Error("Journal SQLite creation directory changed");
	} finally { fs.closeSync(directoryFd); }
	const database = openModelRequestJournalDatabase(databasePath, {create: false, strict: true, safeIntegers: true});
	try {
		const state = states.get(database);
		const owned = state === undefined ? undefined : assertModelRequestJournalDatabase(database);
		if (owned !== undefined && (owned.device !== created.dev || owned.inode !== created.ino)) throw new Error("Journal SQLite exclusive creation changed");
		const initialization = Object.freeze({}) as ModelRequestJournalDatabaseInitialization;
		return Object.freeze({database, storeId, identity: owned === undefined ? undefined : Object.freeze({device: owned.device, inode: owned.inode}), initialization});
	} catch (error) {
		try { database.close(); } catch (closeError) { throw new AggregateError([error, closeError], "Journal SQLite creation and close failed"); }
		throw error;
	}
}
