import { dlopen, FFIType, ptr } from "bun:ffi";
import { AsyncLocalStorage } from "node:async_hooks";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, type Stats } from "node:fs";
import { isAbsolute, join, parse, resolve } from "node:path";

export type RawModelRequestJournalLeaseMode = "shared" | "exclusive";
export interface RawModelRequestJournalFileLease {
	release(): void;
	assertHeld(): void;
}
export interface RawModelRequestJournalLeaseRequest {
	readonly storeId: string;
	readonly control: RawModelRequestJournalLeaseMode;
	readonly maintenance: RawModelRequestJournalLeaseMode;
	readonly ownerId?: string;
	readonly registryId?: string;
}
export interface RawModelRequestJournalLeaseScope {
	readonly storeId: string;
	readonly namespacePath: string;
	readonly recordPath: string;
	readonly ownerId?: string;
	readonly registryId?: string;
	assertHeld(): void;
}
interface LeaseContext {
	readonly request: RawModelRequestJournalLeaseRequest;
	readonly scope: RawModelRequestJournalLeaseScope;
	open: boolean;
}
const leaseContext = new AsyncLocalStorage<LeaseContext>();
interface NativeLeaseRuntime {
	flock(fd: number, operation: number): number;
	home(uid: number): string;
}
let nativeRuntime: NativeLeaseRuntime | undefined;
function runtime(): NativeLeaseRuntime {
	if (process.platform !== "darwin" || process.arch !== "arm64" && process.arch !== "x64") throw new Error("Journal leases unsupported");
	if (nativeRuntime !== undefined) return nativeRuntime;
	const library = dlopen("/usr/lib/libSystem.B.dylib", {
		flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
		getpwuid_r: { args: [FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
		sysconf: { args: [FFIType.i32], returns: FFIType.i64 },
	});
	// Public Darwin LP64 ABI, SDK usr/include/pwd.h:84-95,102:
	// pointers/time_t are 8 bytes, uid_t/gid_t are 4; passwd is 72 bytes,
	// pw_uid is at 16 and pw_dir is at 48 (arm64 and x86_64).
	const account = new Uint8Array(72);
	const result = new Uint8Array(8);
	const accountView = new DataView(account.buffer);
	const resultView = new DataView(result.buffer);
	const accountPointer = ptr(account);
	const resultPointer = ptr(result);
	// unistd.h:299 and getpwent(3) specify this maximum caller-owned buffer.
	const bufferSize = Number(library.symbols.sysconf(71));
	if (!Number.isSafeInteger(bufferSize) || bufferSize < 1 || bufferSize > 1024 * 1024) throw new Error("Journal account buffer unavailable");
	const buffer = new Uint8Array(bufferSize);
	const bufferPointer = ptr(buffer);
	const decodeHome = new TextDecoder("utf-8", {fatal: true});
	nativeRuntime = {
		flock: (fd, operation) => library.symbols.flock(fd, operation),
		home(uid) {
			try {
				const status = library.symbols.getpwuid_r(uid, accountPointer, bufferPointer, buffer.length, resultPointer);
				if (status !== 0 || resultView.getBigUint64(0, true) !== BigInt(accountPointer) || accountView.getUint32(16, true) !== uid) throw new Error("Journal account unavailable");
				// getpwuid_r promises strings in our supplied buffer. Validate the
				// returned pw_dir range before reading, rather than dereferencing it.
				const directoryPointer = accountView.getBigUint64(48, true);
				const offset = directoryPointer - BigInt(bufferPointer);
				if (offset < 0n || offset >= BigInt(buffer.length)) throw new Error("Journal account home unavailable");
				const start = Number(offset);
				const end = buffer.indexOf(0, start);
				if (end < 0) throw new Error("Journal account home unavailable");
				const home = decodeHome.decode(buffer.subarray(start, end));
				if (!isAbsolute(home) || resolve(home) !== home) throw new Error("Journal account unavailable");
				return home;
			} finally {
				account.fill(0);
				result.fill(0);
				buffer.fill(0);
			}
		},
	};
	return nativeRuntime;
}
function validMode(mode: unknown): mode is RawModelRequestJournalLeaseMode {
	return mode === "shared" || mode === "exclusive";
}
function uid(): number {
	const value = process.getuid?.();
	if (value === undefined || !Number.isSafeInteger(value) || value < 0 || value > 0xffffffff || process.geteuid?.() !== value) throw new Error("Journal account unavailable");
	return value;
}
function sameFile(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}
function directory(path: string, owner: number, privateMode: boolean, create: boolean): void {
	if (create) {
		try { mkdirSync(path, { mode: 0o700 }); } catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw new Error("Journal namespace unavailable");
		}
	}
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
	try {
		const stat = fstatSync(fd);
		const named = lstatSync(path);
		if (!stat.isDirectory() || !sameFile(stat, named) || named.isSymbolicLink() || stat.uid !== owner || privateMode && (stat.mode & 0o7777) !== 0o700) throw new Error("Journal namespace rejected");
	} finally { closeSync(fd); }
}
function namespace(storeId: string): string {
	const owner = uid();
	const home = runtime().home(owner);
	// Never consult HOME, cwd, profiles or user-supplied namespace overrides.
	let ancestor = parse(home).root;
	for (const component of home.slice(ancestor.length).split("/").filter(Boolean)) {
		ancestor = join(ancestor, component);
		const stat = lstatSync(ancestor);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Journal home rejected");
	}
	directory(home, owner, false, false);
	let path = home;
	for (const component of ["Library", "Application Support"]) {
		path = join(path, component);
		directory(path, owner, false, true);
	}
	for (const component of ["omp-security-audit", "budget-authority", storeId]) {
		path = join(path, component);
		directory(path, owner, true, true);
	}
	for (const component of ["control", "owners", "accounting"]) directory(join(path, component), owner, true, true);
	return path;
}
/** Shared native fd implementation. This operation never removes its lock inode. */
export function tryAcquireRawModelRequestJournalFileLease(path: string, mode: RawModelRequestJournalLeaseMode, owner: number): RawModelRequestJournalFileLease | undefined {
	let fd: number | undefined;
	try {
		if (!validMode(mode) || owner !== uid()) return undefined;
		const native = runtime();
		fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
		const descriptor = fd;
		const initial = fstatSync(descriptor);
		const check = (): void => {
			const actual = fstatSync(descriptor);
			const named = lstatSync(path);
			if (!actual.isFile() || actual.uid !== owner || (actual.mode & 0o7777) !== 0o600 || actual.nlink !== 1 || named.isSymbolicLink() || !sameFile(actual, named) || !sameFile(actual, initial)) throw new Error("Journal lease inode rejected");
		};
		check();
		if (native.flock(descriptor, (mode === "shared" ? 1 : 2) | 4) !== 0) { closeSync(descriptor); return undefined; }
		let open = true;
		return Object.freeze({
			assertHeld() { if (!open) throw new Error("Journal lease ended"); check(); },
			release() {
				if (!open) return;
				open = false;
				try { native.flock(descriptor, 8); } finally { closeSync(descriptor); }
			},
		});
	} catch {
		if (fd !== undefined) closeSync(fd);
		return undefined;
	}
}
function identifier(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}
/** Fixed nonblocking order. Synchronous acquisition failures throw before a callback can return a Promise. */
export function withRawModelRequestJournalLeases<T>(request: RawModelRequestJournalLeaseRequest, use: (raw: RawModelRequestJournalLeaseScope) => Promise<T>): Promise<T>;
export function withRawModelRequestJournalLeases<T>(request: RawModelRequestJournalLeaseRequest, use: (raw: RawModelRequestJournalLeaseScope) => T): T;
export function withRawModelRequestJournalLeases<T>(request: RawModelRequestJournalLeaseRequest, use: (raw: RawModelRequestJournalLeaseScope) => T | Promise<T>): T | Promise<T> {
	if (request === null || typeof request !== "object" || Reflect.ownKeys(request).some(key => typeof key !== "string" || !["storeId", "control", "maintenance", "ownerId", "registryId"].includes(key))) throw new Error("Journal lease request rejected");
	const {storeId, control, maintenance, ownerId, registryId} = request;
	if (!identifier(storeId) || !validMode(control) || !validMode(maintenance) || ownerId !== undefined && !identifier(ownerId) || registryId !== undefined && !identifier(registryId) || typeof use !== "function") throw new Error("Journal lease request rejected");
	const parent = leaseContext.getStore();
	if (parent !== undefined) {
		if (!parent.open || parent.request.storeId !== storeId) throw new Error("Journal lease scope ended");
		parent.scope.assertHeld();
		if (parent.request.control === "shared" && control === "exclusive" || parent.request.maintenance === "shared" && maintenance === "exclusive" || ownerId !== undefined && parent.request.ownerId !== undefined && ownerId !== parent.request.ownerId || registryId !== undefined && parent.request.registryId !== undefined && registryId !== parent.request.registryId || parent.request.registryId !== undefined && ownerId !== undefined && parent.request.ownerId !== ownerId) throw new Error("Journal lease order rejected");
	}
	const effective: RawModelRequestJournalLeaseRequest = Object.freeze({
		storeId,
		control: parent?.request.control ?? control,
		maintenance: parent?.request.maintenance ?? maintenance,
		...((parent?.request.ownerId ?? ownerId) === undefined ? {} : {ownerId: parent?.request.ownerId ?? ownerId}),
		...((parent?.request.registryId ?? registryId) === undefined ? {} : {registryId: parent?.request.registryId ?? registryId}),
	});
	const namespacePath = parent?.scope.namespacePath ?? namespace(storeId);
	const leases: RawModelRequestJournalFileLease[] = [];
	const acquire = (path: string, mode: RawModelRequestJournalLeaseMode): void => {
		const lease = tryAcquireRawModelRequestJournalFileLease(path, mode, uid());
		if (lease === undefined) throw new Error("Journal lease unavailable");
		leases.push(lease);
	};
	let open = true;
	let context: LeaseContext | undefined;
	const release = (): void => {
		if (!open) return;
		open = false;
		if (context !== undefined) context.open = false;
		const failures: unknown[] = [];
		for (let index = leases.length - 1; index >= 0; index--) {
			try { leases[index]!.release(); } catch (error) { failures.push(error); }
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) throw new AggregateError(failures, "Journal lease releases failed");
	};
	const fail = (error: unknown): never => {
		try { release(); } catch (releaseError) { throw new AggregateError([error, releaseError], "Journal operation and lease release failed"); }
		throw error;
	};
	try {
		if (parent === undefined) {
			acquire(join(namespacePath, "control", `${storeId}.lock`), control);
			acquire(join(namespacePath, "maintenance.lock"), maintenance);
		}
		if (effective.ownerId !== undefined && parent?.request.ownerId === undefined) acquire(join(namespacePath, "owners", `${effective.ownerId}.lock`), "shared");
		if (effective.registryId !== undefined && parent?.request.registryId === undefined) acquire(join(namespacePath, "accounting", `${effective.registryId}.lock`), "exclusive");
		const scope: RawModelRequestJournalLeaseScope = Object.freeze({
			storeId,
			namespacePath,
			recordPath: join(namespacePath, "authority.json"),
			...(effective.ownerId === undefined ? {} : {ownerId: effective.ownerId}),
			...(effective.registryId === undefined ? {} : {registryId: effective.registryId}),
			assertHeld() {
				if (!open || parent !== undefined && !parent.open || namespace(storeId) !== namespacePath) throw new Error("Journal lease scope ended");
				parent?.scope.assertHeld();
				for (const lease of leases) lease.assertHeld();
			},
		});
		context = {request: effective, scope, open: true};
		scope.assertHeld();
		const result = leaseContext.run(context, () => use(scope));
		if (result instanceof Promise) {
			// Use the native intrinsic, not an overridden .then/.finally on a caller's Promise.
			const completion = Promise.withResolvers<T>();
			Promise.prototype.then.call(result, (value: T) => {
				try { scope.assertHeld(); release(); completion.resolve(value); }
				catch (error) { try { fail(error); } catch (failure) { completion.reject(failure); } }
			}, (error: unknown) => {
				try { fail(error); } catch (failure) { completion.reject(failure); }
			});
			return completion.promise;
		}
		if (result !== null && (typeof result === "object" || typeof result === "function") && "then" in result) throw new Error("Journal lease callback must return a native Promise");
		scope.assertHeld();
		release();
		return result;
	} catch (error) { return fail(error); }
}
