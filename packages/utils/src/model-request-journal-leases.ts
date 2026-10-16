import { dlopen, FFIType, ptr } from "bun:ffi";
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
	assertHeld(): void;
}
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
/** Fixed host namespace, nonblocking OS leases, in authority → maintenance → owner → accounting order. */
export async function withRawModelRequestJournalLeases<T>(request: RawModelRequestJournalLeaseRequest, use: (raw: RawModelRequestJournalLeaseScope) => Promise<T>): Promise<T> {
	if (request === null || typeof request !== "object" || Reflect.ownKeys(request).some(key => typeof key !== "string" || !["storeId", "control", "maintenance", "ownerId", "registryId"].includes(key)) || !identifier(request.storeId) || !validMode(request.control) || !validMode(request.maintenance) || request.ownerId !== undefined && !identifier(request.ownerId) || request.registryId !== undefined && !identifier(request.registryId)) throw new Error("Journal lease request rejected");
	const namespacePath = namespace(request.storeId);
	const leases: RawModelRequestJournalFileLease[] = [];
	const acquire = (path: string, mode: RawModelRequestJournalLeaseMode): void => {
		const lease = tryAcquireRawModelRequestJournalFileLease(path, mode, uid());
		if (lease === undefined) throw new Error("Journal lease unavailable");
		leases.push(lease);
	};
	let open = true;
	try {
		acquire(join(namespacePath, "control", `${request.storeId}.lock`), request.control);
		acquire(join(namespacePath, "maintenance.lock"), request.maintenance);
		if (request.ownerId !== undefined) acquire(join(namespacePath, "owners", `${request.ownerId}.lock`), "shared");
		if (request.registryId !== undefined) acquire(join(namespacePath, "accounting", `${request.registryId}.lock`), "exclusive");
		const scope: RawModelRequestJournalLeaseScope = Object.freeze({
			storeId: request.storeId,
			namespacePath,
			recordPath: join(namespacePath, "authority.json"),
			assertHeld() {
				if (!open || namespace(request.storeId) !== namespacePath) throw new Error("Journal lease scope ended");
				for (const lease of leases) lease.assertHeld();
			},
		});
		scope.assertHeld();
		return await use(scope);
	} finally {
		open = false;
		for (const lease of leases.reverse()) lease.release();
	}
}
