import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileLock as NativeFileLock } from "@oh-my-pi/pi-natives";
import { getSessionOwnersDir } from "@oh-my-pi/pi-utils/dirs";
import { isBunTestRuntime } from "@oh-my-pi/pi-utils/env";
import { type FileLockHandle, tryAcquireFileLock, withFileLockSync } from "@oh-my-pi/pi-utils/file-lock";
import { type FsError, hasFsCode, isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { openCloexecSync } from "@oh-my-pi/pi-utils/fs-open";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { peekFileEnds } from "@oh-my-pi/pi-utils/peek-file";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";
import { toError } from "@oh-my-pi/pi-utils/type-guards";
import { isAssistantMessageLine } from "./session-entries";
import {
	overlayTitleSlotContent,
	parseTitleSlotFromContent,
	type SessionTitleUpdate,
	serializeTitleSlot,
} from "./session-title-slot";

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
	type ModelRequestJournalLeaseBinding,
	type ModelRequestJournalRootLeaseScope,
	withVerifiedModelRequestJournalLeases,
} from "./model-request-journal-authority";
import type { ModelRequestAgent, ModelRequestPurpose, ModelRequestScope } from "./model-request-data";
import type {
	FileEntry,
	ModelRequestJournalAck,
	ModelRequestJournalDescriptor,
	ModelRequestLifecycleRecord,
	ModelRequestMetadataEntry,
	ModelRequestRegistryEntry,
	ModelRequestSourceInput,
	ModelRequestSourceLinkInput,
	NewSessionOptions,
	SessionEntry,
	SessionHeader,
} from "./session-entries";
import {
	assertModelRequestLifecycleRecord,
	isCanonicalModelRequestId,
	assertModelRequestSourceLinkInput,
	isModelRequestJournalDescriptor,
	isModelRequestMetadataEntry,
	validateModelRequestJournal,
} from "./model-request-journal";
import { moveFileAcrossDevices } from "./atomic-file";
import { getSessionsDir } from "./dirs";

interface FileMutationGuard {
	body(content: string): void;
	append(line: string): void;
	remove(): void;
	committed?(): void;
}
const principalFileGuards = new Map<string, FileMutationGuard>();
const principalWriteContext = new AsyncLocalStorage<{ principal: FileSessionPrincipalImpl; body: string }>();

function guardForFile(fpath: string): FileMutationGuard | undefined {
	const resolved = path.resolve(fpath);
	const guard = principalFileGuards.get(resolved);
	if (guard) return guard;
	if (!fs.existsSync(resolved)) return undefined;
	const stat = fs.statSync(resolved);
	for (const [name, candidate] of principalFileGuards) {
		if (!fs.existsSync(name)) continue;
		const known = fs.statSync(name);
		if (known.dev === stat.dev && known.ino === stat.ino) return candidate;
	}
	return undefined;
}

function guardFileBody(fpath: string, content: string): void {
	const guard = guardForFile(fpath);
	if (guard) {
		guard.body(content);
		return;
	}
	if (fs.existsSync(fpath) && fs.statSync(fpath).isFile()) rejectUnownedClosedBody(fs.readFileSync(fpath, "utf8"));
	rejectUnownedClosedBody(content);
}

function guardFileRemoval(fpath: string): void {
	const guard = guardForFile(fpath);
	if (guard) { guard.remove(); return; }
	if (!fs.existsSync(fpath) || !fs.statSync(fpath).isFile()) return;
	const content = fs.readFileSync(fpath, "utf8");
	if (principalWriteContext.getStore()?.body !== content) rejectUnownedClosedBody(content);
}

function rejectUnownedClosedBody(content: string): void {
	// Parse rather than scanning spellings: escaped JSON keys are equivalent.
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		let value: unknown;
		try { value = JSON.parse(line); } catch { continue; }
		if (value !== null && typeof value === "object" &&
			("modelRequestJournal" in value || "modelRequestRegistry" in value ||
				"type" in value && (value.type === "model_request_metadata" || value.type === "model_request_registry"))) {
			throw new Error("Managed journal writes require the owning File principal");
		}
	}
}
/** Shared base flags for the held transcript descriptor; callers add `O_APPEND` or `O_TRUNC`. */
const SESSION_WRITE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT;
const utf8Decoder = new TextDecoder("utf-8");

export interface SessionStorageStat {
	size: number;
	mtimeMs: number;
	mtime: Date;
}

export interface SessionStorageWriter {
	/**
	 * Append one newline-terminated line.
	 *
	 * File and memory storage apply the line synchronously before the returned
	 * promise settles, so a software crash after `append` returns (or after a
	 * fire-and-forget call begins) still sees the entry on disk / in body. No
	 * `fsync` — power loss may still drop the last page. Indexed backends update
	 * the local index immediately and queue the remote publish in call order.
	 *
	 * `line` MUST include the trailing newline.
	 */
	append(line: string): Promise<void>;
	/**
	 * Synchronous append when the backend can apply the line before return.
	 * File and memory implement this so {@link SessionManager} can latch the
	 * first write failure before the appending call returns (surfaced by a later
	 * flushSync/close/next append — the turn loop does not throw from append).
	 * Indexed backends update the local index immediately and queue remote I/O.
	 */
	appendSync?(line: string): void;
	/** Resolve once all queued appends complete. No fsync. */
	flush(): Promise<void>;
	/** Drain synchronously flushable queued work when the backend supports it. No fsync. */
	flushSync?(): void;
	/** False once close() has begun/finished. */
	isOpen(): boolean;
	close(): Promise<void>;
	getError(): Error | undefined;
}

/** Optimistic precondition for replacing a session file. */
export interface SessionStorageWriteOptions {
	/** Current UTF-8 byte length, or `null` when the target must not exist. */
	expectedSize?: number | null;
	/**
	 * Require a single atomic replacement. Reject rather than move the old
	 * file aside when the platform refuses rename-over-existing (EPERM).
	 * Managed journal batches require this; ordinary rewrites retain their
	 * existing best-effort replacement behavior when omitted.
	 */
	requireAtomicReplace?: boolean;
}

/**
 * The session changed after a writer loaded it, so replacing it would discard
 * another writer's durable entries.
 */
export class SessionWriteConflictError extends Error {
	readonly path: string;
	readonly expectedSize: number | null;
	readonly actualSize: number | null;

	constructor(path: string, expectedSize: number | null, actualSize: number | null) {
		const expected = expectedSize === null ? "missing" : `${expectedSize} bytes`;
		const actual = actualSize === null ? "missing" : `${actualSize} bytes`;
		super(`Session file changed before rewrite: ${path} (expected ${expected}, found ${actual}).`);
		this.name = "SessionWriteConflictError";
		this.path = path;
		this.expectedSize = expectedSize;
		this.actualSize = actualSize;
	}
}

/**
 * The file publish lock is held by another live writer, so freshness cannot
 * be established. Fail-closed: the staged rewrite is discarded without
 * publishing.
 */
export class SessionLockError extends Error {
	readonly path: string;

	constructor(path: string, detail: string) {
		super(
			`Session publish lock unavailable for ${path}: ${detail}. ` +
				`The staged rewrite was discarded without publishing.`,
		);
		this.name = "SessionLockError";
		this.path = path;
	}
}

/**
 * Optional guards applied by {@link SessionStorage.writeTextAtomic}. The
 * backend MUST check `expectedSize` and call `commitGuard()` synchronously
 * immediately before it makes the staged content visible at `path`. Failed
 * preconditions leave the target untouched. Backends MUST NOT yield between
 * the checks and publishing the write.
 */
export interface WriteTextAtomicOptions extends SessionStorageWriteOptions {
	commitGuard?: () => boolean;
}

export interface SessionStorage {
	/**
	 * Managed journal durability, independent of ordinary storage support.
	 * Missing capabilities are unsupported, including third-party backends.
	 * The supported value requires persistent use, awaited atomic batches with
	 * `requireAtomicReplace: true`, writer flush, drain, and artifact-copy
	 * completion before acknowledgement. It promises separate-reader visibility
	 * and software-process-crash rereads, not fsync or power-loss durability.
	 */
	readonly modelRequestJournal?: "process-crash-reader-visible" | "unsupported";
	/**
	 * `true` when synchronous writes ({@link writeTextSync} and a writer's
	 * {@link SessionStorageWriter.appendSync}) have reached the backing store by
	 * the time they return. File and memory backends apply them in-body and
	 * leave this unset. Indexed backends only update the local index and queue
	 * the remote publish, so a caller that tracks a durable byte size (such as
	 * `SessionManager`) must wait for {@link drain} to confirm before it
	 * advances that size.
	 */
	readonly defersSyncPublish?: boolean;
	/**
	 * Resolve once every write this storage queued for `path` has been confirmed
	 * by, or rejected by, the backing store. In-body backends never queue, so
	 * they omit this; {@link defersSyncPublish} marks the backends that provide
	 * it.
	 */
	confirmWrites?(path: string): Promise<void>;
	ensureDirSync(dir: string): void;
	existsSync(path: string): boolean;
	writeTextSync(path: string, content: string, options?: SessionStorageWriteOptions): void;
	/**
	 * Streaming {@link writeTextSync}: publishes the concatenation of `lines`
	 * with the same staging, size check, and conflict semantics without
	 * materializing it as one string. Optional; callers on backends without
	 * it join the lines and call {@link writeTextSync}.
	 */
	writeLinesSync?(path: string, lines: readonly string[], options?: SessionStorageWriteOptions): void;
	/**
	 * Update the current session title through the storage backend.
	 *
	 * File-like backends rewrite the fixed-width JSONL title slot; indexed
	 * backends can store the semantic title fields and synthesize the slot when
	 * reading.
	 */
	updateSessionTitle(path: string, update: SessionTitleUpdate): Promise<void>;
	statSync(path: string): SessionStorageStat;
	listFilesSync(dir: string, pattern: string): string[];

	exists(path: string): Promise<boolean>;
	readText(path: string): Promise<string>;
	/**
	 * Synchronous {@link readText}. Optional: `SessionManager` reads the file
	 * back to keep another writer's entries when a synchronous rewrite meets
	 * them, and reports the conflict instead on backends without it.
	 */
	readTextSync?(path: string): string;
	/** Read the requested UTF-8 byte windows from the head and tail of the file. */
	readTextSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]>;
	/**
	 * True when any complete `message` record in the file carries an assistant
	 * role. Scans line boundaries across the whole file (middle included) so a
	 * >prefix assistant record before a fixed-size tail window still counts.
	 * Optional: backends without cheap full scans omit it and callers fall back
	 * to prefix/suffix marker evidence.
	 */
	hasAssistantTurn?(path: string): Promise<boolean>;
	writeText(path: string, content: string): Promise<void>;
	writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void>;
	/** Streaming {@link writeTextAtomic}, optional on the same terms as {@link writeLinesSync}. */
	writeLinesAtomic?(path: string, lines: readonly string[], options?: WriteTextAtomicOptions): Promise<void>;
	rename(path: string, nextPath: string): Promise<void>;
	unlink(path: string): Promise<void>;
	deleteSessionWithArtifacts(sessionPath: string): Promise<void>;
	/**
	 * Run a synchronous session mutation under the backend's cross-process
	 * lock. Optional because only backends with a process-shared lock can
	 * participate in close-time draft GC.
	 */
	withSessionFileLockSync?<T>(sessionPath: string, operation: () => T): T;
	/**
	 * Claim this process's ownership of the session `sessionId` it writes to
	 * `sessionPath`, until the returned release callback runs. Returns `null`
	 * while another live process holds the claim, or when `sessionPath` now
	 * holds a different session (another session was moved onto it), so the
	 * caller's appends would land in that session's journal; `SessionManager`
	 * then moves its session to a sibling instead of writing that file.
	 * Optional because only backends with a process-owned lock can tell that
	 * another process writes a session.
	 */
	claimSession?(sessionId: string, sessionPath: string): (() => void) | null;
	/**
	 * Atomically delete a session and its artifacts only when `shouldDelete`
	 * accepts the current session content. Optional because backends without a
	 * cross-process conditional-delete primitive must skip opportunistic GC.
	 */
	deleteSessionWithArtifactsIf?(sessionPath: string, shouldDelete: (content: string) => boolean): Promise<boolean>;
	openWriter(path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter;
	/**
	 * Wait for every backing write scheduled by this storage to become durably
	 * visible. Sync backends (file, memory) return immediately because their
	 * writes complete in-body; async backends (Redis/SQL via
	 * {@link IndexedSessionStorage}) await their per-path queues so a caller
	 * driving a graceful shutdown does not exit while a fire-and-forget
	 * `writeTextSync` publish is still on the wire.
	 */
	drain(): Promise<void>;
}

// FinalizationRegistry to clean up leaked file descriptors
const writerRegistry = new FinalizationRegistry<number>(fd => {
	try {
		fs.closeSync(fd);
	} catch {
		// Ignore - fd may already be closed or invalid
	}
});

class FileSessionStorageWriter implements SessionStorageWriter {
	#fd: number;
	/** Identity of the file `#fd` is open on: fixed for the descriptor's lifetime, so read once per descriptor. */
	#heldIdentity: { ino: bigint; dev: bigint } | undefined;
	#fpath: string;
	#publishLock: ((append: () => void, landed: () => boolean) => void) | undefined;
	#closed = false;
	#error: Error | undefined;
	#onError: ((err: Error) => void) | undefined;

	constructor(
		fpath: string,
		options?: {
			flags?: "a" | "w";
			onError?: (err: Error) => void;
			publishLock?: (append: () => void, landed: () => boolean) => void;
		},
	) {
		this.#fpath = fpath;
		this.#publishLock = options?.publishLock;
		this.#onError = options?.onError;
		const flags = options?.flags ?? "a";
		// Ensure parent directory exists
		const dir = path.dirname(fpath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		// Open file once, keep fd for lifetime
		this.#fd = openCloexecSync(
			fpath,
			SESSION_WRITE_FLAGS | (flags === "w" ? fs.constants.O_TRUNC : fs.constants.O_APPEND),
		);
		// Register for cleanup if abandoned without close()
		writerRegistry.register(this, this.#fd, this);
	}

	#heldFile(): { ino: bigint; dev: bigint } {
		if (!this.#heldIdentity) {
			const held = fs.fstatSync(this.#fd, { bigint: true });
			this.#heldIdentity = { ino: held.ino, dev: held.dev };
		}
		return this.#heldIdentity;
	}

	/**
	 * A publish that renamed a fresh file over the session path leaves this
	 * writer's descriptor on the orphaned previous inode, where the append would
	 * be silently lost. Under the publish lock no cooperating replacement can
	 * interleave, so re-open the live path when its identity changed.
	 *
	 * Returns the size of the descriptor the next write appends to: while the
	 * path still names the held file, the one path `stat` serves both the
	 * identity check and the append rollback point.
	 */
	#reopenIfReplaced(): number {
		const held = this.#heldFile();
		let live: fs.BigIntStats;
		try {
			live = fs.statSync(this.#fpath, { bigint: true });
		} catch (err) {
			if (isEnoent(err)) return fs.fstatSync(this.#fd).size;
			throw err;
		}
		if (live.ino === held.ino && live.dev === held.dev) return Number(live.size);
		const nextFd = openCloexecSync(this.#fpath, SESSION_WRITE_FLAGS | fs.constants.O_APPEND);
		writerRegistry.unregister(this);
		try {
			fs.closeSync(this.#fd);
		} catch {
			// Replacing the descriptor abandoned the old one; nothing else to do.
		}
		this.#fd = nextFd;
		this.#heldIdentity = undefined;
		writerRegistry.register(this, nextFd, this);
		const next = fs.fstatSync(nextFd, { bigint: true });
		this.#heldIdentity = { ino: next.ino, dev: next.dev };
		return Number(next.size);
	}

	/**
	 * Whether the descriptor the last append wrote through is still the file the
	 * session path names. A vanished path counts as landed: nothing replaced it,
	 * and `#reopenIfReplaced` would append to the same descriptor again.
	 */
	#holdsLivePath(): boolean {
		const held = this.#heldFile();
		let live: fs.BigIntStats;
		try {
			live = fs.statSync(this.#fpath, { bigint: true });
		} catch (err) {
			if (isEnoent(err)) return true;
			throw err;
		}
		return live.ino === held.ino && live.dev === held.dev;
	}

	#recordError(err: unknown): Error {
		const error = toError(err);
		if (!this.#error) this.#error = error;
		this.#onError?.(error);
		return error;
	}

	/** Append `line` at the end of the held descriptor, rolling back to `originalSize` on failure. */
	#writeNow(line: string, originalSize: number): void {
		const buf = Buffer.from(line, "utf-8");
		let offset = 0;
		try {
			while (offset < buf.length) {
				const written = fs.writeSync(this.#fd, buf, offset, buf.length - offset);
				if (written === 0) {
					throw new Error("Short write");
				}
				offset += written;
			}
		} catch (writeError) {
			try {
				fs.ftruncateSync(this.#fd, originalSize);
			} catch (rollbackError) {
				// Windows refuses ftruncate on an O_APPEND handle. Reopen without
				// O_APPEND and verify its identity before rolling back: the path may
				// now name a different session file after an external replacement.
				try {
					const rollbackFd = fs.openSync(this.#fpath, "r+");
					try {
						const original = fs.fstatSync(this.#fd);
						const current = fs.fstatSync(rollbackFd);
						if (original.dev !== current.dev || original.ino !== current.ino) {
							throw new Error("Session file was replaced before append rollback");
						}
						fs.ftruncateSync(rollbackFd, originalSize);
					} finally {
						fs.closeSync(rollbackFd);
					}
				} catch (pathRollbackError) {
					// Keep the write failure visible in the message.
					throw new AggregateError(
						[toError(writeError), toError(rollbackError), toError(pathRollbackError)],
						`Session append failed and its partial bytes could not be rolled back: ${toError(writeError).message}`,
					);
				}
			}
			throw writeError;
		}
	}

	appendSync(line: string): void {
		if (this.#closed) throw new Error("Writer closed");
		if (this.#error) throw this.#error;
		const guard = guardForFile(this.#fpath);
		if (guard) guard.append(line);
		else guardFileBody(this.#fpath, line);
		// Write in-body so software crash after the call still sees the entry.
		// Microtask batching used to leave completed transcript lines only in
		// memory until the next event-loop turn; process crash then lost every
		// post-checkpoint event. flush/flushSync remain no-op drains (no fsync).
		// The publish lock serializes the append against a concurrent rewrite's
		// check-then-rename, which would otherwise erase the appended turn.
		try {
			if (this.#publishLock) {
				this.#publishLock(
					() => this.#writeNow(line, this.#reopenIfReplaced()),
					() => this.#holdsLivePath(),
				);
			} else {
				this.#writeNow(line, fs.fstatSync(this.#fd).size);
			}
			guard?.committed?.();
		} catch (err) {
			throw this.#recordError(err);
		}
	}

	async append(line: string): Promise<void> {
		this.appendSync(line);
	}

	async flush(): Promise<void> {
		if (this.#error) throw this.#error;
	}

	flushSync(): void {
		if (this.#error) throw this.#error;
	}

	isOpen(): boolean {
		return !this.#closed;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		// Unregister from finalization - we're closing properly
		writerRegistry.unregister(this);
		try {
			fs.closeSync(this.#fd);
		} catch {
			// Ignore close errors
		}
		if (this.#error) throw this.#error;
	}

	getError(): Error | undefined {
		return this.#error;
	}
}

/**
 * Cross-process publish serialization for the file backend. The guard-then-
 * rename sequence in `writeTextSync`/`writeTextAtomic` is synchronous (no
 * in-process interleave is possible), but a second terminal runs in another
 * process: without a shared lock its append can land between our freshness
 * check and our rename, and the rename then erases it.
 *
 * Exclusion comes in two layers. The outer layer is a process-owned OS gate
 * held from before the lockfile claim until after release: the kernel
 * reclaims it on process exit (including SIGKILL), so no wall-clock age
 * heuristic decides liveness and no unlink races ownership (F2). The inner
 * layer is the lockfile protocol below, kept so writers on a previous
 * binary still interoperate through the same file they always have; among
 * current writers the gate serializes the whole claim, which also closes
 * the two-reclaimer unlink race (rJDh). Against a previous-binary peer the
 * protocol degrades to its released semantics, documented on the steal
 * path. Appends claim the lockfile only when a previous-binary publisher
 * can be in flight (see `#withAppendLock`), so a transcript line does not
 * create and unlink a file beside the session. The window that remains is
 * non-cooperating writers (plain editors), against which the size check
 * still fails closed whenever the skew is detectable.
 *
 * The region is held for microseconds and never yields, so in-process
 * contention is impossible; cross-process contention fails closed after a
 * short bounded wait instead of blocking the turn loop.
 */
const SESSION_PUBLISH_LOCK_WAIT_MS = 500;
const SESSION_PUBLISH_LOCK_POLL_MS = 2;

const publishLockSleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleepSyncMs(ms: number): void {
	if ("sleepSync" in Bun && typeof Bun.sleepSync === "function") {
		Bun.sleepSync(ms);
		return;
	}
	Atomics.wait(publishLockSleepBuffer, 0, 0, ms);
}

function publishLockPid(content: string): number | undefined {
	const match = /^(\d+):(\d+)\s*$/.exec(content);
	if (!match) return undefined;
	const pid = Number.parseInt(match[1], 10);
	return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// ESRCH: no such process (dead). EPERM: alive without signal
		// permission. Anything else: assume alive (fail closed).
		return hasFsCode(err, "EPERM") || !hasFsCode(err, "ESRCH");
	}
}

/**
 * This process's ownership leases by session id, shared by every
 * `FileSessionStorage` instance: managers in one process share one lease per
 * session and only ever contend with other processes. The OS reclaims a lease
 * when its process exits, so a crashed owner never blocks a later claim.
 */
const sessionLeases = new Map<string, { lease: FileLockHandle; holders: number }>();

const TEST_SESSION_OWNERS_DIR_ENV = "PI_TEST_SESSION_OWNERS_DIR";

/**
 * A test run never touches the real state dir for session ownership leases:
 * bun test processes use one per-user directory in the OS temp dir. It is
 * exported when this module loads, before a test can spawn an omp process,
 * so spawned processes meet the same leases. Session ids are unique, so
 * concurrent test processes can share it, and it is reused across runs (bun
 * test fires no exit hook to remove it).
 */
function testSessionOwnersDir(): string | undefined {
	const exported = process.env[TEST_SESSION_OWNERS_DIR_ENV];
	if (exported || !isBunTestRuntime()) return exported;
	const uid = typeof process.getuid === "function" ? process.getuid() : os.userInfo().username;
	const dir = path.join(os.tmpdir(), `omp-test-session-owners-${uid}`);
	process.env[TEST_SESSION_OWNERS_DIR_ENV] = dir;
	return dir;
}
testSessionOwnersDir();

function sessionOwnersDir(): string {
	return testSessionOwnersDir() ?? getSessionOwnersDir();
}

/** Bytes read to find a header at claim time: the title slot plus a header line fit well inside. */
const SESSION_HEADER_PREFIX_BYTES = 64 * 1024;

/**
 * The session id in the header of the file at `sessionPath`, read
 * synchronously from a bounded prefix (past the title slot), or `undefined`
 * when there is no readable file or no header in that prefix.
 */
function readSessionHeaderIdSync(sessionPath: string): string | undefined {
	let prefix: string;
	try {
		const fd = fs.openSync(sessionPath, "r");
		try {
			const buf = Buffer.alloc(SESSION_HEADER_PREFIX_BYTES);
			prefix = buf.toString("utf8", 0, fs.readSync(fd, buf, 0, buf.length, 0));
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return undefined;
	}
	if (parseTitleSlotFromContent(prefix)) prefix = prefix.slice(prefix.indexOf("\n") + 1);
	const end = prefix.indexOf("\n");
	if (end === -1) return undefined;
	try {
		const entry: unknown = JSON.parse(prefix.slice(0, end));
		if (entry && typeof entry === "object" && "type" in entry && entry.type === "session" && "id" in entry) {
			return typeof entry.id === "string" ? entry.id : undefined;
		}
	} catch {}
	return undefined;
}

/**
 * Take a session's ownership lease without waiting, or `null` while another
 * process holds it. A process writing the session holds it (see
 * `FileSessionStorage.claimSession`) until it exits; `omp gc` probes it to tell
 * whether a session is live. Keyed by the session id from the journal's
 * header, not by the file's path, so every process that reaches the journal
 * (through a symlink, a hard link, or after a move) meets the same lease. Ids
 * read from a file are untrusted: anything but a plain token is hashed so it
 * cannot name a path outside the directory. Throws when the lock cannot be
 * probed.
 */
export function tryAcquireSessionLease(sessionId: string): FileLockHandle | null {
	const name = /^[A-Za-z0-9_-]{1,128}$/.test(sessionId)
		? sessionId
		: `h-${Bun.hash.wyhash(sessionId).toString(16).padStart(16, "0")}`;
	const lockPath = path.join(sessionOwnersDir(), name);
	// Linux (abstract socket) and Windows (named mutex) locks never touch the
	// filesystem; elsewhere the lock is a `flock` sidecar in that directory. The
	// sidecars are empty and never removed: unlinking a flock file can split one
	// lease between a holder of the old inode and a creator of a new one.
	if (process.platform !== "linux" && process.platform !== "win32") {
		const dir = path.dirname(lockPath);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		// The test-run dir sits in the shared OS temp dir, where another local
		// user could pre-create it or plant a symlink: refuse anything but a
		// directory this user owns that nobody else can enter.
		const st = fs.lstatSync(dir);
		const uid = process.getuid?.();
		if (!st.isDirectory() || (uid !== undefined && st.uid !== uid) || (st.mode & 0o077) !== 0) {
			throw new Error(`Session ownership lease directory ${dir} is not a private directory owned by this user`);
		}
	}
	return tryAcquireFileLock(lockPath);
}

/** Approximate size (UTF-16 units synchronously, bytes through a sink) buffered per staging-file write when streaming a body. */
const LINE_STREAM_CHUNK = 1 << 20;

/** Write `lines` to a new file at `target` in bounded chunks, never holding their full concatenation. */
function writeLinesToFileSync(target: string, lines: readonly string[]): void {
	const fd = fs.openSync(target, "w");
	try {
		let chunk = "";
		for (const line of lines) {
			chunk += line;
			if (chunk.length < LINE_STREAM_CHUNK) continue;
			fs.writeFileSync(fd, chunk);
			chunk = "";
		}
		if (chunk.length > 0) fs.writeFileSync(fd, chunk);
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Async {@link writeLinesToFileSync} through a buffered Bun file sink.
 * `target` must be a fresh path: a sink does not truncate an existing file.
 */
async function writeLinesToFile(target: string, lines: readonly string[]): Promise<void> {
	const sink = Bun.file(target).writer({ highWaterMark: LINE_STREAM_CHUNK });
	try {
		for (const line of lines) sink.write(line);
	} catch (err) {
		try {
			// Release the descriptor so the caller can discard the staging file.
			await sink.end();
		} catch {
			// The write failure is the error worth reporting.
		}
		throw err;
	}
	await sink.end();
}

export class FileSessionStorage implements SessionStorage {
	readonly modelRequestJournal = "process-crash-reader-visible";

	#assertExpectedSize(fpath: string, expectedSize: number | null | undefined): void {
		if (expectedSize === undefined) return;
		let actualSize: number | null;
		try {
			actualSize = fs.statSync(fpath).size;
		} catch (error) {
			if (!isEnoent(error)) throw error;
			actualSize = null;
		}
		if (actualSize !== expectedSize) {
			throw new SessionWriteConflictError(fpath, expectedSize, actualSize);
		}
	}

	#publishLockPath(fpath: string): string {
		return path.join(path.dirname(fpath), `.${path.basename(fpath)}.lock`);
	}

	/**
	 * Run `task` (the freshness check through the final rename) while holding
	 * the cross-process publish lock for `fpath`. The OS gate is acquired
	 * first and released last, so the lockfile claim below only ever runs
	 * while this process provably owns the name.
	 */
	#withPublishLock(fpath: string, task: () => void): void {
		const lockPath = this.#publishLockPath(fpath);
		// The lock lives beside the session file: the directory may not exist
		// yet when the first publish creates it (writeTextSync creates it for
		// the temp file, but the lock claim runs first). Match that behavior
		// so a first publish to a new directory does not fail with ENOENT.
		this.ensureDirSync(path.dirname(lockPath));
		const osGate = this.#acquireOsPublishLock(fpath, this.#osGatePath(lockPath));
		try {
			this.#acquirePublishLock(fpath, lockPath);
			try {
				task();
			} finally {
				this.#releasePublishLock(fpath, lockPath);
			}
		} finally {
			osGate.release();
		}
	}

	#releasePublishLock(fpath: string, lockPath: string): void {
		try {
			fs.unlinkSync(lockPath);
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Failed to remove session publish lock", { sessionFile: fpath, lockPath });
			}
		}
	}

	/**
	 * Run `append` under the OS gate, claiming the lockfile only when a
	 * previous-binary publisher may overlap it. Current publishers hold the
	 * gate across their freshness check and rename, so among current writers
	 * the gate alone excludes them and an append touches nothing beside the
	 * session. A previous binary takes only the lockfile, so its claim stays
	 * observable: an append that finds the lockfile waits for it exactly as
	 * before, and one that saw it appear (or saw the path renamed away from
	 * the descriptor it wrote through) waits for that publisher to finish and
	 * re-appends to whatever file it published when the line did not survive.
	 * That reproduces the serial order "their publish, then our append" the
	 * lockfile used to enforce, and fails closed when the holder outlives the
	 * bounded wait.
	 *
	 * `lockPath` and `gatePath` are the writer's precomputed
	 * {@link #publishLockPath} and {@link #osGatePath}. The held descriptor
	 * already lives in the session directory, so the directory is recreated
	 * only when acquiring the gate fails (the `flock` sidecar needs it).
	 */
	#withAppendLock(fpath: string, lockPath: string, gatePath: string, append: () => void, landed: () => boolean): void {
		let osGate: NativeFileLock;
		try {
			osGate = this.#acquireOsPublishLock(fpath, gatePath);
		} catch (err) {
			if (err instanceof SessionLockError) throw err;
			this.ensureDirSync(path.dirname(lockPath));
			osGate = this.#acquireOsPublishLock(fpath, gatePath);
		}
		try {
			let appended = false;
			if (!fs.existsSync(lockPath)) {
				append();
				appended = true;
				// Lockfile before identity: a previous-binary publisher whose
				// freshness check preceded our write holds the lockfile through its
				// rename, so it is either still visible here or has already moved
				// the path off our descriptor.
				if (!fs.existsSync(lockPath) && landed()) return;
			}
			this.#acquirePublishLock(fpath, lockPath);
			try {
				if (!appended || !landed()) append();
			} finally {
				this.#releasePublishLock(fpath, lockPath);
			}
		} finally {
			osGate.release();
		}
	}

	/**
	 * Claim the process-owned gate at `gatePath` ({@link #osGatePath}) for
	 * `fpath`, failing closed after the same bounded wait the lockfile claim
	 * uses. The native handle keeps ownership, never the file content, so
	 * suspension and SIGKILL cannot strand it as stealable.
	 */
	#acquireOsPublishLock(fpath: string, gatePath: string): NativeFileLock {
		const deadline = Date.now() + SESSION_PUBLISH_LOCK_WAIT_MS;
		for (;;) {
			const gate = NativeFileLock.tryAcquire(gatePath);
			if (gate.acquired) return gate;
			gate.release();
			if (Date.now() >= deadline) {
				throw new SessionLockError(fpath, "another writer holds the publish lock");
			}
			sleepSyncMs(SESSION_PUBLISH_LOCK_POLL_MS);
		}
	}

	/**
	 * Sidecar carrying the OS gate. It lives beside the lockfile (same trust
	 * domain). Platforms backed by `flock(2)` require this path to remain
	 * persistent: unlinking it after release can race a successor that already
	 * opened the old inode, allowing a third process to lock a new inode at the
	 * same path concurrently. Only handle ownership matters, so a
	 * crash-orphaned sidecar is inert and the next acquire simply reopens it.
	 */
	#osGatePath(lockPath: string): string {
		return `${lockPath}.os`;
	}

	#acquirePublishLock(fpath: string, lockPath: string): void {
		const deadline = Date.now() + SESSION_PUBLISH_LOCK_WAIT_MS;
		for (;;) {
			if (this.#createPublishLock(lockPath)) return;
			if (Date.now() >= deadline) {
				throw new SessionLockError(fpath, "another writer holds the publish lock");
			}
			sleepSyncMs(SESSION_PUBLISH_LOCK_POLL_MS);
		}
	}

	#createPublishLock(lockPath: string): boolean {
		if (this.#tryCreatePublishLock(lockPath)) return true;
		if (!this.#stealStalePublishLock(lockPath)) return false;
		return this.#tryCreatePublishLock(lockPath);
	}

	/**
	 * Claim the lock name and record its holder. Returns false when another
	 * holder already owns the name. A failure to record the holder removes the
	 * file it just created, so no caller meets a contentless lock it can
	 * neither attribute to a live pid nor safely steal.
	 */
	#tryCreatePublishLock(lockPath: string): boolean {
		let fd: number;
		try {
			fd = fs.openSync(lockPath, "wx", 0o600);
		} catch (err) {
			if (!hasFsCode(err, "EEXIST")) throw toError(err);
			return false;
		}
		const record = `${process.pid}:${Date.now()}\n`;
		try {
			fs.writeFileSync(fd, record);
		} catch (err) {
			try {
				fs.closeSync(fd);
			} catch {
				// Descriptor unusable after the failed write; the unlink matters.
			}
			try {
				fs.unlinkSync(lockPath);
			} catch {
				// A concurrent steal already removed it.
			}
			throw toError(err);
		}
		// Verify the record survived: a concurrent stale-lock steal may have
		// removed our file between create and write (a POSIX fd write succeeds
		// on the unlinked inode), in which case we hold nothing. Retry instead
		// of entering the region unexclusively (hV-oE). The path still naming
		// our inode proves the record is there (holders only ever create and
		// unlink lock files), and comparing identities costs two stats instead
		// of a full open/read/close. The descriptor stays open until after the
		// comparison so the inode cannot be freed and its number reused by a
		// successor's file; bigint keeps 64-bit Windows file IDs exact.
		try {
			const held = fs.fstatSync(fd, { bigint: true });
			const named = fs.statSync(lockPath, { bigint: true });
			return held.ino === named.ino && held.dev === named.dev;
		} catch {
			// Removed under us: hold nothing, retry.
			return false;
		} finally {
			try {
				fs.closeSync(fd);
			} catch {
				// Ignore close errors; the lock content is already written.
			}
		}
	}

	/**
	 * Remove the lock only when its holder is verifiably dead. Returns whether
	 * the caller should retry acquisition: true when the lock vanished (ours
	 * to take) or was stolen, false when a live holder owns it.
	 */
	#stealStalePublishLock(lockPath: string): boolean {
		let content: string;
		try {
			content = fs.readFileSync(lockPath, "utf8");
		} catch (err) {
			return !!isEnoent(err);
		}
		const pid = publishLockPid(content);
		if (pid !== undefined) {
			if (isPidAlive(pid)) return false;
		} else if (!this.#isOrphanedPublishLock(lockPath)) {
			// Contentless or malformed with a fresh mtime: a live acquirer may
			// still be between create and record. Only a file older than any
			// live acquisition can be a crash orphan (hV-oE).
			return false;
		}
		// Re-read immediately before removal: a concurrent recovery may have
		// replaced the dead holder's file with a live lock since the first
		// read. Remove only what was verified (rJDh).
		try {
			if (fs.readFileSync(lockPath, "utf8") !== content) return false;
		} catch (err) {
			return !!isEnoent(err);
		}
		try {
			fs.unlinkSync(lockPath);
			return true;
		} catch (err) {
			return !!isEnoent(err);
		}
	}

	/**
	 * Whether a contentless or malformed lock file is old enough that no live
	 * acquirer could own it: holders write their record microseconds after
	 * create and release after a check-and-rename critical section, so
	 * anything older than the full acquisition wait budget is a crash orphan.
	 */
	#isOrphanedPublishLock(lockPath: string): boolean {
		let mtimeMs: number;
		try {
			mtimeMs = fs.statSync(lockPath).mtimeMs;
		} catch {
			// Vanished mid-check; the steal path re-verifies before removal.
			return true;
		}
		return Date.now() - mtimeMs > SESSION_PUBLISH_LOCK_WAIT_MS;
	}

	ensureDirSync(dir: string): void {
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
	}

	existsSync(path: string): boolean {
		return fs.existsSync(path);
	}

	writeTextSync(fpath: string, content: string, options?: SessionStorageWriteOptions): void {
		guardFileBody(fpath, content);
		this.#publishSync(fpath, tempPath => fs.writeFileSync(tempPath, content), options);
	}

	/**
	 * Streams `lines` into the staging file in bounded chunks. A subclass or
	 * spy that intercepts {@link writeTextSync} still sees every full rewrite:
	 * the lines are then joined and routed through it.
	 */
	writeLinesSync(fpath: string, lines: readonly string[], options?: SessionStorageWriteOptions): void {
		if (guardForFile(fpath)) guardFileBody(fpath, lines.join(""));
		else for (const line of lines) guardFileBody(fpath, line);
		if (this.writeTextSync !== FileSessionStorage.prototype.writeTextSync) {
			this.writeTextSync(fpath, lines.join(""), options);
			return;
		}
		this.#publishSync(fpath, tempPath => writeLinesToFileSync(tempPath, lines), options);
	}

	/** Stage a body via `stage` at a fresh temp path beside `fpath`, then check freshness and rename it in. */
	#publishSync(
		fpath: string,
		stage: (tempPath: string) => void,
		options: SessionStorageWriteOptions | undefined,
	): void {
		const dir = path.dirname(fpath);
		this.ensureDirSync(dir);
		const tempPath = path.join(dir, `.${path.basename(fpath)}.${Snowflake.next()}.tmp`);
		try {
			stage(tempPath);
		} catch (err) {
			this.#discardTemp(tempPath, fpath);
			throw toError(err);
		}
		// The freshness check through the final rename runs under the
		// cross-process publish lock: no cooperating writer can slip an
		// append between the size check and the rename.
		try {
			this.#withPublishLock(fpath, () => {
				this.#assertExpectedSize(fpath, options?.expectedSize);
				try {
					this.renameSync(tempPath, fpath);
				} catch (err) {
					if (options?.requireAtomicReplace || !hasFsCode(err, "EPERM")) throw toError(err);
					this.#replaceSessionFileAfterEpermSync(tempPath, fpath, err);
				}
			});
		} catch (err) {
			this.#discardTemp(tempPath, fpath);
			throw toError(err);
		}
	}

	async updateSessionTitle(fpath: string, update: SessionTitleUpdate): Promise<void> {
		const fd = fs.openSync(fpath, "r+");
		try {
			const buf = Buffer.from(serializeTitleSlot(update), "utf-8");
			let offset = 0;
			while (offset < buf.length) {
				const written = fs.writeSync(fd, buf, offset, buf.length - offset, offset);
				if (written === 0) {
					throw new Error("Short write");
				}
				offset += written;
			}
		} catch (err) {
			throw toError(err);
		} finally {
			fs.closeSync(fd);
		}
	}

	statSync(path: string): SessionStorageStat {
		const stats = fs.statSync(path);
		return { size: stats.size, mtimeMs: stats.mtimeMs, mtime: stats.mtime };
	}

	listFilesSync(dir: string, pattern: string): string[] {
		try {
			return Array.from(new Bun.Glob(pattern).scanSync(dir)).map(name => path.join(dir, name));
		} catch {
			return [];
		}
	}

	async exists(path: string): Promise<boolean> {
		try {
			await fs.promises.access(path);
			return true;
		} catch (err) {
			if (isEnoent(err)) return false;
			throw err;
		}
	}

	readText(path: string): Promise<string> {
		return Bun.file(path).text();
	}

	readTextSync(path: string): string {
		return fs.readFileSync(path, "utf8");
	}

	async readTextSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		return peekFileEnds(path, prefixBytes, suffixBytes, (head, tail) => [
			utf8Decoder.decode(head),
			utf8Decoder.decode(tail),
		]);
	}

	async hasAssistantTurn(path: string): Promise<boolean> {
		const fileHandle = await fsp.open(path, "r");
		try {
			for await (const line of fileHandle.readLines()) {
				if (isAssistantMessageLine(line)) return true;
			}
			return false;
		} finally {
			await fileHandle.close();
		}
	}

	async writeText(path: string, content: string): Promise<void> {
		guardFileBody(path, content);
		await Bun.write(path, content, { createPath: true });
		guardForFile(path)?.committed?.();
	}

	async writeTextAtomic(fpath: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		guardFileBody(fpath, content);
		await this.#publishAtomic(fpath, tempPath => fs.promises.writeFile(tempPath, content), options);
	}

	/**
	 * Streams `lines` into the staging file through a buffered file sink. A
	 * subclass or spy that intercepts {@link writeTextAtomic} still sees every
	 * full rewrite: the lines are then joined and routed through it.
	 */
	async writeLinesAtomic(fpath: string, lines: readonly string[], options?: WriteTextAtomicOptions): Promise<void> {
		if (guardForFile(fpath)) guardFileBody(fpath, lines.join(""));
		else for (const line of lines) guardFileBody(fpath, line);
		if (this.writeTextAtomic !== FileSessionStorage.prototype.writeTextAtomic) {
			return this.writeTextAtomic(fpath, lines.join(""), options);
		}
		await this.#publishAtomic(fpath, tempPath => writeLinesToFile(tempPath, lines), options);
	}

	/** Async {@link #publishSync}: stages via `stage`, then guard-checks and publishes without yielding. */
	async #publishAtomic(
		fpath: string,
		stage: (tempPath: string) => Promise<void>,
		options: WriteTextAtomicOptions | undefined,
	): Promise<void> {
		const dir = path.resolve(fpath, "..");
		const tempPath = path.join(dir, `.${path.basename(fpath)}.${Snowflake.next()}.tmp`);
		await fs.promises.mkdir(dir, { recursive: true });
		try {
			await stage(tempPath);
		} catch (err) {
			this.#discardTemp(tempPath, fpath);
			throw toError(err);
		}
		// Guard-check + rename MUST NOT be separated by an await. A concurrent
		// synchronous rewrite (flushSync -> #rewriteSynchronously) can otherwise
		// publish a fresh body between the check and the rename, and this stale
		// staged body would overwrite it. Sync rename closes that window.
		if (options?.commitGuard && !options.commitGuard()) {
			this.#discardTemp(tempPath, fpath);
			return;
		}
		try {
			// The publish lock spans the freshness check through the rename (and
			// its EPERM fallback): a cooperating appender or rewrite cannot
			// interleave, and appenders re-open a replaced path before writing.
			this.#withPublishLock(fpath, () => {
				this.#assertExpectedSize(fpath, options?.expectedSize);
				try {
					this.renameSync(tempPath, fpath);
					return;
				} catch (err) {
					if (options?.requireAtomicReplace || !hasFsCode(err, "EPERM")) throw toError(err);
					this.#replaceSessionFileAfterEpermSync(tempPath, fpath, err, options?.commitGuard);
				}
			});
		} catch (err) {
			this.#discardTemp(tempPath, fpath);
			throw toError(err);
		}
	}

	/**
	 * Sync rename hook. Split from `rename` so `writeTextAtomic` can perform its
	 * guard-then-publish step without a yield, and so tests can inject
	 * Windows-style EPERM at the sync layer used by the atomic path.
	 */
	renameSync(source: string, target: string): void {
		guardFileRemoval(source);
		if (guardForFile(target)) guardFileBody(target, fs.readFileSync(source, "utf8"));
		else guardFileRemoval(target);
		fs.renameSync(source, target);
		guardForFile(target)?.committed?.();
	}

	#discardTemp(tempPath: string, targetPath: string): void {
		try {
			fs.unlinkSync(tempPath);
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Failed to remove session rewrite temp file", {
					sessionFile: targetPath,
					tempPath,
					error: toError(err).message,
				});
			}
		}
	}

	#replaceSessionFileAfterEpermSync(
		tempPath: string,
		targetPath: string,
		renameError: unknown,
		commitGuard?: () => boolean,
	): void {
		const dir = path.resolve(targetPath, "..");
		const backupPath = path.join(dir, `${path.basename(targetPath)}.${Snowflake.next()}.bak`);
		try {
			this.renameSync(targetPath, backupPath);
		} catch (moveAsideError) {
			if (isEnoent(moveAsideError)) {
				if (commitGuard && !commitGuard()) {
					this.#discardTemp(tempPath, targetPath);
					return;
				}
				this.renameSync(tempPath, targetPath);
				return;
			}
			throw toError(renameError);
		}
		if (commitGuard && !commitGuard()) {
			// A concurrent synchronous rewrite published a fresh body between the
			// move-aside and this point. Restore the moved-aside file so we do
			// not overwrite it with our staged (stale) body, and drop the temp
			// so `writeTextAtomic`'s "discard on abandon" contract holds.
			try {
				this.renameSync(backupPath, targetPath);
			} catch (restoreErr) {
				logger.warn("Failed to restore backup after commitGuard rejection", {
					sessionFile: targetPath,
					backupPath,
					error: toError(restoreErr).message,
				});
			}
			this.#discardTemp(tempPath, targetPath);
			return;
		}
		try {
			this.renameSync(tempPath, targetPath);
		} catch (replaceError) {
			try {
				this.renameSync(backupPath, targetPath);
			} catch (rollbackErr) {
				const rollbackError = toError(rollbackErr);
				throw new Error(
					`Failed to replace session file after EPERM (original: ${toError(renameError).message}; retry: ${
						toError(replaceError).message
					}; rollback: ${rollbackError.message})`,
					{ cause: toError(renameError) },
				);
			}
			throw toError(replaceError);
		}
		try {
			fs.unlinkSync(backupPath);
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Failed to remove session rewrite backup", {
					sessionFile: targetPath,
					backupPath,
					error: toError(err).message,
				});
			}
		}
	}

	async rename(path: string, nextPath: string): Promise<void> {
		guardFileRemoval(path);
		guardFileRemoval(nextPath);
		try {
			await fs.promises.rename(path, nextPath);
		} catch (err) {
			throw toError(err);
		}
	}

	unlink(path: string): Promise<void> {
		guardFileRemoval(path);
		return fs.promises.unlink(path);
	}

	drain(): Promise<void> {
		// File writes complete synchronously in-body via fs.writeFileSync /
		// fs.renameSync, so there is no queued work to await.
		return Promise.resolve();
	}

	openWriter(fpath: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter {
		if (options?.flags === "w" && guardForFile(fpath)) throw new Error("A principal-owned session cannot be truncated by an openWriter call");
		const lockPath = this.#publishLockPath(fpath);
		const gatePath = this.#osGatePath(lockPath);
		return new FileSessionStorageWriter(fpath, {
			...options,
			publishLock: (append, landed) => this.#withAppendLock(fpath, lockPath, gatePath, append, landed),
		});
	}

	/** Run a synchronous session mutation under its cross-process lock. */
	withSessionFileLockSync<T>(sessionPath: string, operation: () => T): T {
		return withFileLockSync(sessionPath, operation);
	}

	/**
	 * The lease is an OS lock (abstract socket, named mutex, or `flock` sidecar
	 * under ~/.omp/run/session-owners), so the kernel drops a dead owner's claim.
	 * Never throws: a lock that cannot be taken for another reason counts as
	 * owned, so it never moves a session off its file.
	 */
	claimSession(sessionId: string, sessionPath: string): (() => void) | null {
		const onDisk = readSessionHeaderIdSync(sessionPath);
		if (onDisk !== undefined && onDisk !== sessionId) return null;
		let held = sessionLeases.get(sessionId);
		if (!held) {
			let lease: FileLockHandle | null;
			try {
				lease = tryAcquireSessionLease(sessionId);
			} catch (err) {
				logger.debug("Session ownership lease unavailable", { sessionId, error: toError(err).message });
				return () => {};
			}
			if (!lease) return null;
			held = { lease, holders: 0 };
			sessionLeases.set(sessionId, held);
		}
		const claim = held;
		claim.holders++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (--claim.holders > 0) return;
			sessionLeases.delete(sessionId);
			claim.lease.release();
		};
	}

	/**
	 * Conditionally delete under the same cross-process lock used by the first
	 * durable append to a draft-only session.
	 */
	deleteSessionWithArtifactsIf(sessionPath: string, shouldDelete: (content: string) => boolean): Promise<boolean> {
		guardFileRemoval(sessionPath);
		const deleted = this.withSessionFileLockSync(sessionPath, () => {
			const content = fs.readFileSync(sessionPath, "utf-8");
			if (!shouldDelete(content)) return false;

			fs.unlinkSync(sessionPath);
			const artifactsDir = sessionPath.slice(0, -6);
			try {
				fs.rmSync(artifactsDir, { recursive: true, force: true });
			} catch (err) {
				const error = toError(err);
				throw new Error(
					`Session file deleted but failed to remove artifacts directory ${artifactsDir}: ${error.message}`,
					{ cause: error },
				);
			}
			return true;
		});
		return Promise.resolve(deleted);
	}

	/**
	 * Delete a session file and its artifacts directory.
	 * Artifacts are stored in a sibling directory with the same name minus .jsonl extension.
	 */
	async deleteSessionWithArtifacts(sessionPath: string): Promise<void> {
		// Delete the session file itself
		await this.unlink(sessionPath);

		// Compute artifacts directory: /path/to/session.jsonl -> /path/to/session
		const artifactsDir = sessionPath.slice(0, -6);

		// Delete artifacts directory if it exists. Missing directories are fine, but
		// surface real cleanup failures because the session file is already gone.
		try {
			await fsp.rm(artifactsDir, { recursive: true, force: true });
		} catch (err) {
			const error = toError(err);
			throw new Error(
				`Session file deleted but failed to remove artifacts directory ${artifactsDir}: ${error.message}`,
				{
					cause: error,
				},
			);
		}

		// Remove EPERM-rewrite leftovers (`<name>.jsonl.<snowflake>.bak`): the
		// picker scan would otherwise resurrect the deleted session from the
		// newest stale backup (#11499). Best-effort — a locked file warns
		// instead of failing the delete the user asked for.
		const base = path.basename(sessionPath);
		for (const bak of this.listFilesSync(path.dirname(sessionPath), "*.bak")) {
			if (!path.basename(bak).startsWith(`${base}.`)) continue;
			try {
				await fsp.unlink(bak);
			} catch (err) {
				logger.warn("Failed to remove stale session backup during delete", {
					path: bak,
					error: toError(err).message,
				});
			}
		}
	}
}

function matchesPattern(name: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (pattern.startsWith("*.")) {
		return name.endsWith(pattern.slice(1));
	}
	return name === pattern;
}

/**
 * Name of `key` when it sits directly inside `resolvedDir` (a `path.resolve`d
 * directory), else `undefined`. Key-indexed storages keep whatever spelling
 * callers wrote, so both sides are resolved: on Windows `/sessions/x` and the
 * `path.join`-built `\sessions\x\…` keys must list as the same directory.
 */
export function directChildKeyName(resolvedDir: string, key: string): string | undefined {
	const name = path.basename(key);
	if (!name || name.includes("/") || name.includes("\\")) return undefined;
	return path.resolve(path.dirname(key)) === resolvedDir ? name : undefined;
}

class MemorySessionStorageWriter implements SessionStorageWriter {
	#storage: MemorySessionStorage;
	#path: string;
	#closed = false;
	#error: Error | undefined;
	#onError: ((err: Error) => void) | undefined;

	constructor(
		storage: MemorySessionStorage,
		path: string,
		options?: { flags?: "a" | "w"; onError?: (err: Error) => void },
	) {
		this.#storage = storage;
		this.#path = path;
		this.#onError = options?.onError;
		if ((options?.flags ?? "a") === "w") {
			this.#storage.writeTextSync(path, "");
		}
	}

	#recordError(err: unknown): Error {
		const error = toError(err);
		if (!this.#error) this.#error = error;
		this.#onError?.(error);
		return error;
	}

	appendSync(line: string): void {
		if (this.#closed) throw new Error("Writer closed");
		if (this.#error) throw this.#error;
		try {
			// O(1) append — push onto the path's indexed in-memory entry.
			this.#storage.appendSync(this.#path, line);
		} catch (err) {
			throw this.#recordError(err);
		}
	}

	async append(line: string): Promise<void> {
		this.appendSync(line);
	}

	async flush(): Promise<void> {
		if (this.#error) throw this.#error;
	}

	flushSync(): void {
		if (this.#error) throw this.#error;
	}

	isOpen(): boolean {
		return !this.#closed;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
	}

	getError(): Error | undefined {
		return this.#error;
	}
}

interface MemoryFileEntry {
	chunks: string[];
	cumulativeBytes: number[];
	size: number;
	mtimeMs: number;
}

function createMemoryFileEntry(content: string, mtimeMs: number): MemoryFileEntry {
	const size = Buffer.byteLength(content, "utf-8");
	return {
		chunks: size === 0 ? [] : [content],
		cumulativeBytes: size === 0 ? [] : [size],
		size,
		mtimeMs,
	};
}

function appendMemoryChunk(entry: MemoryFileEntry, chunk: string): void {
	const chunkSize = Buffer.byteLength(chunk, "utf-8");
	if (chunkSize === 0) return;
	entry.size += chunkSize;
	entry.chunks.push(chunk);
	entry.cumulativeBytes.push(entry.size);
}

function normalizeByteLimit(maxBytes: number, size: number): number {
	if (!(maxBytes > 0) || size === 0) return 0;
	return Math.min(Math.trunc(maxBytes), size);
}

function lowerBound(values: readonly number[], target: number): number {
	let lo = 0;
	let hi = values.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (values[mid] < target) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo;
}

function upperBound(values: readonly number[], target: number): number {
	let lo = 0;
	let hi = values.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (values[mid] <= target) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo;
}

function joinChunkRange(chunks: readonly string[], start: number, end: number): string {
	const count = end - start;
	if (count <= 0) return "";
	if (count === 1) return chunks[start] ?? "";

	let content = "";
	for (let i = start; i < end; i++) {
		content += chunks[i];
	}
	return content;
}

function decodeChunkByteRange(chunk: string, startByte: number, endByte: number, chunkSize: number): string {
	if (startByte >= endByte) return "";
	if (startByte === 0 && endByte === chunkSize) return chunk;
	if (chunk.length === chunkSize) return chunk.slice(startByte, endByte);
	const bytes = Buffer.from(chunk, "utf-8");
	return utf8Decoder.decode(bytes.subarray(startByte, endByte));
}

function materializeMemoryEntry(entry: MemoryFileEntry): string {
	const { chunks } = entry;
	if (chunks.length === 0) return "";
	if (chunks.length === 1) return chunks[0];

	const content = chunks.join("");
	entry.chunks = [content];
	entry.cumulativeBytes = [entry.size];
	return content;
}

function sliceChunksHead(entry: MemoryFileEntry, maxBytes: number): string {
	const limit = normalizeByteLimit(maxBytes, entry.size);
	if (limit === 0) return "";
	if (limit >= entry.size) return materializeMemoryEntry(entry);

	const boundaryIndex = lowerBound(entry.cumulativeBytes, limit);
	const chunkStart = boundaryIndex === 0 ? 0 : entry.cumulativeBytes[boundaryIndex - 1];
	const chunkEnd = entry.cumulativeBytes[boundaryIndex];
	if (chunkEnd === limit) return joinChunkRange(entry.chunks, 0, boundaryIndex + 1);

	const chunk = entry.chunks[boundaryIndex];
	const chunkPrefix = decodeChunkByteRange(chunk, 0, limit - chunkStart, chunkEnd - chunkStart);
	return joinChunkRange(entry.chunks, 0, boundaryIndex) + chunkPrefix;
}

function sliceChunksTail(entry: MemoryFileEntry, maxBytes: number): string {
	const limit = normalizeByteLimit(maxBytes, entry.size);
	if (limit === 0) return "";
	if (limit >= entry.size) return materializeMemoryEntry(entry);

	const startByte = entry.size - limit;
	const boundaryIndex = upperBound(entry.cumulativeBytes, startByte);
	const chunkStart = boundaryIndex === 0 ? 0 : entry.cumulativeBytes[boundaryIndex - 1];
	const chunkEnd = entry.cumulativeBytes[boundaryIndex];
	const chunkOffset = startByte - chunkStart;
	if (chunkOffset === 0) return joinChunkRange(entry.chunks, boundaryIndex, entry.chunks.length);

	const chunk = entry.chunks[boundaryIndex];
	const chunkSuffix = decodeChunkByteRange(chunk, chunkOffset, chunkEnd - chunkStart, chunkEnd - chunkStart);
	return chunkSuffix + joinChunkRange(entry.chunks, boundaryIndex + 1, entry.chunks.length);
}

/** A missing in-memory file, coded `ENOENT` like the file backend so callers' `isEnoent` checks agree. */
function memoryFileNotFound(path: string): FsError {
	return Object.assign(new Error(`File not found: ${path}`), { code: "ENOENT" });
}

export class MemorySessionStorage implements SessionStorage {
	readonly modelRequestJournal = "unsupported";

	// Each path keeps appended string chunks plus cumulative UTF-8 byte offsets.
	// Full reads materialize the chunks into one string chunk, so repeated reads
	// do not re-join stale history. Later appends still stay O(1) by pushing
	// after that materialized chunk. Prefix/suffix reads binary-search byte
	// offsets and join only the requested window.
	#files = new Map<string, MemoryFileEntry>();

	#requireEntry(path: string): MemoryFileEntry {
		const entry = this.#files.get(path);
		if (!entry) throw memoryFileNotFound(path);
		return entry;
	}

	ensureDirSync(_dir: string): void {
		// No-op for in-memory storage.
	}

	existsSync(path: string): boolean {
		return this.#files.has(path);
	}

	writeTextSync(path: string, content: string, options?: SessionStorageWriteOptions): void {
		const actualSize = this.#files.get(path)?.size ?? null;
		if (options?.expectedSize !== undefined && actualSize !== options.expectedSize) {
			throw new SessionWriteConflictError(path, options.expectedSize, actualSize);
		}
		this.#files.set(path, createMemoryFileEntry(content, Date.now()));
	}

	async updateSessionTitle(path: string, update: SessionTitleUpdate): Promise<void> {
		const entry = this.#requireEntry(path);
		this.#files.set(
			path,
			createMemoryFileEntry(overlayTitleSlotContent(materializeMemoryEntry(entry), update), Date.now()),
		);
	}

	/**
	 * Internal O(1) append used by {@link MemorySessionStorageWriter}. Lazily
	 * creates the entry. External callers should go through `openWriter()`
	 * rather than touching the mirror directly.
	 */
	appendSync(path: string, chunk: string): void {
		const mtimeMs = Date.now();
		let entry = this.#files.get(path);
		if (!entry) {
			entry = createMemoryFileEntry("", mtimeMs);
			this.#files.set(path, entry);
		}
		appendMemoryChunk(entry, chunk);
		entry.mtimeMs = mtimeMs;
	}

	statSync(path: string): SessionStorageStat {
		const entry = this.#requireEntry(path);
		return {
			size: entry.size,
			mtimeMs: entry.mtimeMs,
			mtime: new Date(entry.mtimeMs),
		};
	}

	listFilesSync(dir: string, pattern: string): string[] {
		const resolvedDir = path.resolve(dir);
		const files: string[] = [];
		for (const key of this.#files.keys()) {
			const name = directChildKeyName(resolvedDir, key);
			if (name === undefined || !matchesPattern(name, pattern)) continue;
			files.push(key);
		}
		return files;
	}

	exists(path: string): Promise<boolean> {
		return Promise.resolve(this.existsSync(path));
	}

	readText(path: string): Promise<string> {
		const entry = this.#files.get(path);
		if (!entry) return Promise.reject(memoryFileNotFound(path));
		return Promise.resolve(materializeMemoryEntry(entry));
	}

	readTextSync(path: string): string {
		const entry = this.#files.get(path);
		if (!entry) throw memoryFileNotFound(path);
		return materializeMemoryEntry(entry);
	}

	readTextSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		const entry = this.#files.get(path);
		if (!entry) return Promise.reject(memoryFileNotFound(path));
		return Promise.resolve([sliceChunksHead(entry, prefixBytes), sliceChunksTail(entry, suffixBytes)]);
	}

	async hasAssistantTurn(path: string): Promise<boolean> {
		const entry = this.#files.get(path);
		if (!entry) throw memoryFileNotFound(path);
		for (const line of materializeMemoryEntry(entry).split("\n")) {
			if (isAssistantMessageLine(line)) return true;
		}
		return false;
	}

	writeText(path: string, content: string): Promise<void> {
		this.writeTextSync(path, content);
		return Promise.resolve();
	}

	writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		if (options?.commitGuard && !options.commitGuard()) return Promise.resolve();
		this.writeTextSync(path, content, { expectedSize: options?.expectedSize });
		return Promise.resolve();
	}

	rename(path: string, nextPath: string): Promise<void> {
		const entry = this.#files.get(path);
		if (!entry) return Promise.reject(memoryFileNotFound(path));
		this.#files.set(nextPath, entry);
		this.#files.delete(path);
		return Promise.resolve();
	}

	unlink(path: string): Promise<void> {
		this.#files.delete(path);
		return Promise.resolve();
	}
	deleteSessionWithArtifacts(_sessionPath: string): Promise<void> {
		return Promise.resolve();
	}

	drain(): Promise<void> {
		return Promise.resolve();
	}

	openWriter(path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter {
		return new MemorySessionStorageWriter(this, path, options);
	}
}

declare const JOURNAL_EXECUTION: unique symbol;
declare const FILE_JOURNAL_CELL: unique symbol;
declare const JOURNAL_SESSION: unique symbol;
declare const JOURNAL_OWNER: unique symbol;

export type JournalExecutionState =
	| "untracked" | "required-pending" | "required-ready" | "required-faulted" | "required-revoked";

export interface ModelRequestExecution {
	readonly [JOURNAL_EXECUTION]: true;
	readonly modelRequestJournalLeaseBinding?: ModelRequestJournalLeaseBinding;
	readonly journalState: JournalExecutionState;
	readonly modelRequestScope: ModelRequestScope | undefined;
}

export interface ModelRequestJournalOwner {
	readonly [JOURNAL_OWNER]: true;
}

export interface JournalSession {
	readonly [JOURNAL_SESSION]: true;
}

export interface ExistingFileSessionOpenInput {
	readonly cwd: string;
	readonly sessionDir?: string;
	readonly sessionFile?: string;
	/** Only an exact existing header match; never a new-session ID override. */
	readonly sessionId?: string;
}

export interface FileJournalCell extends SessionStorage {
	readonly [FILE_JOURNAL_CELL]: true;
	getSessionId(): string;
	getSessionFile(): string;
	getSessionDir(): string;
	resetToNewSession(options?: NewSessionOptions, forcedSessionFile?: string, cwd?: string): string;
	moveOffSessionFile(reason: "open-elsewhere" | "replaced" | "contested"): string;
	fork(): Promise<{ oldSessionFile: string; newSessionFile: string }>;
	getHeader(): Readonly<SessionHeader>;
	getEntries(): readonly SessionEntry[];
	getEntry(id: string): Readonly<SessionEntry> | undefined;
	getLeafId(): string | null;
	branch(leafId: string | null): void;
	ensureOnDisk(): Promise<void>;
	flush(): Promise<void>;
	flushSync(): void;
	close(): Promise<void>;
	seal(): void;
	releaseRetainedEntries(): void;
	setSessionFile(sessionFile: string): Promise<void>;
	newSession(options?: NewSessionOptions): Promise<string>;
	moveTo(newCwd: string, targetSessionDir?: string): Promise<void>;
	appendMessage(message: Extract<ModelRequestSourceInput, {kind: "assistant"}>["args"][0]): string;
	appendModelUsage(...args: Extract<ModelRequestSourceInput, {kind: "model_usage"}>["args"]): string | undefined;
	appendModelRequestMetadata(owner: ModelRequestJournalOwner, record: ModelRequestLifecycleRecord): Promise<ModelRequestJournalAck>;
	appendModelRequestSource(owner: ModelRequestJournalOwner, source: ModelRequestSourceInput, link: ModelRequestSourceLinkInput): Promise<ModelRequestJournalAck>;
}

interface ExecutionFamily {
	state: JournalExecutionState;
	readonly binding: ModelRequestJournalLeaseBinding | undefined;
	cell?: FileSessionPrincipalImpl;
	root?: FileSessionPrincipalImpl;
	session?: JournalSession;
	readonly ancestors: ExecutionFamily[];
}
interface ExecutionState {
	readonly family: ExecutionFamily;
	readonly agent: ModelRequestAgent;
	readonly purpose: ModelRequestPurpose;
}
interface JournalSessionState {
	readonly cell: FileSessionPrincipalImpl;
	readonly root: FileSessionPrincipalImpl;
	readonly binding: ModelRequestJournalLeaseBinding;
	readonly family: ExecutionFamily;
	readonly owner: ModelRequestJournalOwner;
	readonly generation: number;
	readonly rootGeneration: number;
	readonly registryId: string;
	readonly registryEpoch: string;
	readonly journalId: string;
	readonly journalEpoch: string;
	readonly ownerId: string;
	throughSeq: number;
	closed: boolean;
}
interface RegistrationReceipt {
	readonly cell: FileSessionPrincipalImpl;
	readonly root: FileSessionPrincipalImpl;
	readonly generation: number;
	readonly rootGeneration: number;
	readonly binding: ModelRequestJournalLeaseBinding;
	readonly scope: ModelRequestJournalRootLeaseScope;
	readonly registrationThroughSeq: number;
	readonly ownerId: string;
	readonly journalId: string;
	readonly journalEpoch: string;
}

const executionStates = new WeakMap<object, ExecutionState>();
const cellInstances = new WeakSet<object>();
const sessionStates = new WeakMap<object, JournalSessionState>();
const ownerSessions = new WeakMap<object, JournalSession>();
const liveCellsByPath = new Map<string, FileSessionPrincipalImpl>();
const liveCellsById = new Map<string, FileSessionPrincipalImpl>();
let journalRequired = false;

function unavailable(): never {
	throw new Error("Model request journal capability is unavailable");
}

function requireExecution(value: unknown): ExecutionState {
	if (value === null || typeof value !== "object") unavailable();
	const state = executionStates.get(value);
	if (!state) unavailable();
	return state;
}

function familyState(family: ExecutionFamily): JournalExecutionState {
	for (const ancestor of family.ancestors) {
		const state = familyState(ancestor);
		if (state === "required-faulted" || state === "required-revoked") family.state = state;
	}
	if (journalRequired && family.state === "untracked") family.state = "required-pending";
	return family.state;
}

class JournalExecutionImpl implements ModelRequestExecution {
	declare readonly [JOURNAL_EXECUTION]: true;
	get modelRequestJournalLeaseBinding(): ModelRequestJournalLeaseBinding | undefined {
		return requireExecution(this).family.binding;
	}
	get journalState(): JournalExecutionState { return familyState(requireExecution(this).family); }
	get modelRequestScope(): ModelRequestScope | undefined {
		const { family, agent, purpose } = requireExecution(this);
		if (familyState(family) !== "required-ready" || !family.cell || !family.root) return undefined;
		return Object.freeze({
			sessionId: family.cell.getSessionId(), rootSessionId: family.root.getSessionId(), agent, purpose,
		});
	}
}
Object.freeze(JournalExecutionImpl.prototype);

export function assertJournalExecutionIdentity(execution: unknown): asserts execution is ModelRequestExecution {
	requireExecution(execution);
}

export function createJournalExecution(input: Readonly<{
	binding?: ModelRequestJournalLeaseBinding; agent: ModelRequestAgent; purpose: ModelRequestPurpose;
}>): ModelRequestExecution {
	if (!input || typeof input !== "object" || Reflect.ownKeys(input).some(key =>
		typeof key !== "string" || !["binding", "agent", "purpose"].includes(key))) unavailable();
	const agent = input.agent;
	if (!agent || typeof agent.id !== "string" || !agent.id || typeof agent.name !== "string" ||
		(agent.kind !== "main" && agent.kind !== "sub") || !Number.isSafeInteger(agent.depth) || agent.depth < 0) unavailable();
	if (input.binding !== undefined) journalRequired = true;
	const family: ExecutionFamily = {
		state: journalRequired ? "required-pending" : "untracked", binding: input.binding, ancestors: [],
	};
	const execution = Object.freeze(new JournalExecutionImpl());
	executionStates.set(execution, { family, agent: Object.freeze({ ...agent }), purpose: input.purpose });
	return execution;
}

export function deriveJournalExecution(parent: ModelRequestExecution, patch: Readonly<{
	agent?: ModelRequestAgent; purpose?: ModelRequestPurpose;
}>): ModelRequestExecution {
	const state = requireExecution(parent);
	familyState(state.family);
	const execution = Object.freeze(new JournalExecutionImpl());
	executionStates.set(execution, {
		family: state.family, agent: Object.freeze({ ...(patch.agent ?? state.agent) }), purpose: patch.purpose ?? state.purpose,
	});
	return execution;
}

export function assertJournalExecutionReady(execution: ModelRequestExecution): void {
	const family = requireExecution(execution).family;
	const status = familyState(family);
	if (status === "untracked") return;
	if (status !== "required-ready" || !family.cell || !family.root || !family.session) unavailable();
	family.cell.assertSession(family.session, execution);
}

function requireCell(cell: FileJournalCell): FileSessionPrincipalImpl {
	if (!(cell instanceof FileSessionPrincipalImpl) || !cellInstances.has(cell)) unavailable();
	return cell;
}

function sourceEntry(entry: SessionEntry): boolean {
	return entry.type === "model_usage" || entry.type === "message" && entry.message.role === "assistant";
}

function strictFile(content: string): { header: SessionHeader; entries: SessionEntry[] } {
	if (!content.endsWith("\n")) unavailable();
	const values: unknown[] = [];
	for (const line of content.split("\n")) {
		if (!line) continue;
		let value: unknown;
		try { value = JSON.parse(line); } catch { unavailable(); }
		if (value === null || typeof value !== "object" || !("type" in value)) unavailable();
		if (value.type === "title" && values.length === 0) continue;
		values.push(value);
	}
	const first = values[0];
	if (!first || typeof first !== "object" || !("type" in first) || first.type !== "session" ||
		!("id" in first) || typeof first.id !== "string" || !first.id ||
		!("cwd" in first) || typeof first.cwd !== "string" || !("timestamp" in first) ||
		typeof first.timestamp !== "string" || !Number.isFinite(Date.parse(first.timestamp))) unavailable();
	if ("modelRequestJournal" in first && first.modelRequestJournal !== undefined &&
		!isModelRequestJournalDescriptor(first.modelRequestJournal)) unavailable();
	const seen = new Set<string>([first.id]);
	for (const value of values.slice(1)) {
		if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string" ||
			!("parentId" in value) || (value.parentId !== null && typeof value.parentId !== "string") ||
			seen.has(value.id)) unavailable();
		if ("type" in value && value.type === "model_request_metadata" && !isModelRequestMetadataEntry(value)) unavailable();
		seen.add(value.id);
	}
	// The boundary checks physical framing and entry identity. The canonical
	// strict journal reader below validates every issued metadata field/sequence.
	const file = values as FileEntry[];
	const physicalHeader = file[0] as SessionHeader;
	const slot = parseTitleSlotFromContent(content);
	const header = slot ? { ...physicalHeader, title: slot.title || undefined, titleSource: slot.source } : physicalHeader;
	const entries = file.slice(1) as SessionEntry[];
	if (header.modelRequestJournal) validateModelRequestJournal([header, ...entries]);
	else if (entries.some(entry => entry.type === "model_request_metadata")) unavailable();
	if (header.modelRequestRegistry) readRegistrySnapshot(header, entries);
	else if (entries.some(entry => entry.type === "model_request_registry")) unavailable();
	return { header, entries };
}


function closedKeys(value: object, keys: readonly string[]): boolean {
	return Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function readRegistrySnapshot(header: SessionHeader, entries: readonly SessionEntry[]): {
	registryId: string; registryEpoch: string; rootSessionId: string; throughSeq: number;
} {
	const registry = header.modelRequestRegistry;
	if (!registry || !closedKeys(registry, ["schemaVersion", "registryId", "registryEpoch", "rootSessionId"]) ||
		registry.schemaVersion !== 1 || registry.rootSessionId !== header.id ||
		!/^jr_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(registry.registryId) ||
		!isCanonicalModelRequestId(registry.registryEpoch)) unavailable();
	type Member = { record: Extract<ModelRequestRegistryEntry["record"], { event: "member-registered" }>;
		ownerRegistered: boolean; closed: boolean; ownerClosed: boolean; throughSeq?: number; outcome?: "closed" | "faulted" };
	const members = new Map<string, Member>();
	const owners = new Map<string, Member>();
	const active = new Map<string, Member>();
	let throughSeq = 0;
	for (const entry of entries) {
		if (entry.type !== "model_request_registry") continue;
		if (!closedKeys(entry, ["type", "id", "parentId", "timestamp", "schemaVersion", "registryId", "registryEpoch", "seq", "record"]) ||
			entry.parentId !== null || entry.schemaVersion !== 1 || entry.registryId !== registry.registryId ||
			entry.registryEpoch !== registry.registryEpoch || entry.seq !== ++throughSeq ||
			!Number.isSafeInteger(entry.seq) || typeof entry.timestamp !== "string" || !Number.isFinite(Date.parse(entry.timestamp))) unavailable();
		const record = entry.record;
		if (!record || typeof record !== "object" || !isCanonicalModelRequestId(record.journalEpoch) ||
			typeof record.sessionId !== "string" || !/^[A-Za-z0-9_-]+$/.test(record.sessionId)) unavailable();
		if (record.event === "member-registered") {
			if (!closedKeys(record, ["event", "sessionId", "parentSessionId", "ownerId", "persistenceOwnerRef", "journalRef", "journalEpoch", "firstSeq"]) ||
				!isCanonicalModelRequestId(record.ownerId) || !isCanonicalModelRequestId(record.persistenceOwnerRef) ||
				record.firstSeq !== 1 || record.journalRef !== record.sessionId ||
				members.has(record.journalEpoch) || owners.has(record.ownerId) || active.has(record.sessionId)) unavailable();
			if (record.sessionId === header.id) {
				if (record.parentSessionId !== null) unavailable();
			} else {
				const parent = record.parentSessionId === null ? undefined : active.get(record.parentSessionId);
				if (!parent?.ownerRegistered || parent.closed) unavailable();
			}
			const member: Member = { record, ownerRegistered: false, closed: false, ownerClosed: false };
			members.set(record.journalEpoch, member); owners.set(record.ownerId, member); active.set(record.sessionId, member);
		} else if (record.event === "owner-registered") {
			const member = owners.get(record.ownerId);
			if (!closedKeys(record, ["event", "ownerId", "sessionId", "journalEpoch"]) || !member ||
				member.record.sessionId !== record.sessionId || member.record.journalEpoch !== record.journalEpoch ||
				member.ownerRegistered || member.closed) unavailable();
			member.ownerRegistered = true;
		} else if (record.event === "member-closed") {
			const member = members.get(record.journalEpoch);
			if (!closedKeys(record, ["event", "sessionId", "journalEpoch", "throughSeq", "outcome"]) || !member?.ownerRegistered ||
				member.record.sessionId !== record.sessionId || member.closed ||
				!Number.isSafeInteger(record.throughSeq) || record.throughSeq < 0 ||
				(record.outcome !== "closed" && record.outcome !== "faulted")) unavailable();
			member.closed = true; member.throughSeq = record.throughSeq; member.outcome = record.outcome;
			active.delete(record.sessionId);
		} else if (record.event === "owner-closed") {
			const member = owners.get(record.ownerId);
			if (!closedKeys(record, ["event", "ownerId", "sessionId", "journalEpoch", "throughSeq", "outcome"]) ||
				!member?.closed || member.ownerClosed || member.record.sessionId !== record.sessionId ||
				member.record.journalEpoch !== record.journalEpoch || member.throughSeq !== record.throughSeq ||
				member.outcome !== record.outcome) unavailable();
			member.ownerClosed = true;
		} else unavailable();
	}
	if (header.modelRequestJournal) {
		for (const epoch of header.modelRequestJournal.epochs) {
			const member = members.get(epoch.journalEpoch);
			if (!member?.ownerRegistered || member.record.sessionId !== header.id ||
				member.record.ownerId !== epoch.journalOwnerId) unavailable();
		}
	}
	return { ...registry, throughSeq };
}
function registryId(): string {
	const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
	let value = BigInt(Date.now()) << 80n;
	const bytes = crypto.getRandomValues(new Uint8Array(10));
	for (const [index, byte] of bytes.entries()) value |= BigInt(byte) << BigInt((9 - index) * 8);
	let encoded = "";
	for (let index = 0; index < 26; index++) { encoded = alphabet[Number(value & 31n)] + encoded; value >>= 5n; }
	return `jr_${encoded}`;
}

class FileSessionPrincipalImpl implements FileJournalCell {
	declare readonly [FILE_JOURNAL_CELL]: true;
	readonly #storage = new FileSessionStorage();
	#header: SessionHeader;
	#entries: SessionEntry[];
	#sessionFile: string;
	#sessionDir: string;
	#generation = 0;
	#queue: Promise<void> = Promise.resolve();
	#fault: Error | undefined;
	#closed = false;
	#session: JournalSession | undefined;
	#allowedBody: string | undefined;
	#expectedSize: number | null;
	#lease: FileLockHandle;
	#writer: SessionStorageWriter | undefined;
	#sealed = false;
	readonly #families = new Set<ExecutionFamily>();
	readonly #agentFamilies = new Map<string, ExecutionFamily>();
	#relocating: { source: string; dest: string } | undefined;
	#leafId: string | null = null;
	readonly #persistenceOwnerRef = randomUUID();

	constructor(input: ExistingFileSessionOpenInput) {
		const dir = path.resolve(input.sessionDir ?? (input.sessionFile === undefined ? getSessionsDir() : path.dirname(input.sessionFile)));
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const stat = fs.lstatSync(dir);
		if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) unavailable();
		this.#sessionDir = fs.realpathSync(dir);
		if (input.sessionFile !== undefined && fs.existsSync(input.sessionFile) && fs.statSync(input.sessionFile).size > 0) {
			const filename = path.resolve(input.sessionFile);
			if (path.dirname(filename) !== this.#sessionDir || fs.realpathSync(path.dirname(filename)) !== this.#sessionDir) unavailable();
			const named = fs.lstatSync(filename);
			if (!named.isFile() || named.isSymbolicLink() || named.uid !== process.getuid?.() || named.nlink !== 1) unavailable();
			const content = fs.readFileSync(filename, "utf8");
			const loaded = strictFile(content);
			if (input.sessionId !== undefined && loaded.header.id !== input.sessionId) unavailable();
			this.#header = loaded.header;
			this.#entries = loaded.entries;
			this.#sessionFile = filename;
			this.#expectedSize = Buffer.byteLength(content);
		} else {
			if (input.sessionId !== undefined) unavailable();
			const id = Bun.randomUUIDv7();
			const timestamp = new Date().toISOString();
			this.#header = { type: "session", version: 3, id, timestamp, cwd: path.resolve(input.cwd) };
			this.#entries = [];
			this.#sessionFile = input.sessionFile === undefined
				? path.join(this.#sessionDir, `${timestamp.replace(/:/g, "-")}_${id}.jsonl`)
				: path.resolve(input.sessionFile);
			if (path.dirname(this.#sessionFile) !== this.#sessionDir) unavailable();
			this.#expectedSize = fs.existsSync(this.#sessionFile) ? fs.statSync(this.#sessionFile).size : null;
		}
		this.#leafId = this.#entries.findLast(entry => entry.type !== "model_request_metadata" && entry.type !== "model_request_registry")?.id ?? null;
		if (liveCellsById.has(this.#header.id)) unavailable();
		const lease = tryAcquireSessionLease(this.#header.id);
		if (!lease) unavailable();
		this.#lease = lease;
		cellInstances.add(this);
		liveCellsByPath.set(this.#sessionFile, this);
		liveCellsById.set(this.#header.id, this);
		principalFileGuards.set(this.#sessionFile, {
			body: content => this.#guardBody(content),
			append: line => this.#guardAppend(line),
			remove: () => this.#guardRemove(),
			committed: () => this.#refreshCommitted(),
		});
		Object.freeze(this);
	}


	readonly modelRequestJournal = "process-crash-reader-visible";

	#assertPath(fpath: string): string {
		const resolved = path.resolve(fpath);
		for (const filename of [this.#sessionFile, this.#relocating?.source, this.#relocating?.dest]) {
			if (filename === undefined) continue;
			const artifacts = filename.slice(0, -6);
			if (resolved === filename || resolved === artifacts || resolved.startsWith(`${artifacts}${path.sep}`)) return resolved;
		}
		unavailable();
	}

	#refreshCommitted(): void {
		const filename = this.#relocating && !fs.existsSync(this.#relocating.source) ? this.#relocating.dest : this.#sessionFile;
		if (!fs.existsSync(filename)) {
			if (this.#expectedSize !== null) unavailable();
			return;
		}
		const content = this.#storage.readTextSync(filename);
		const next = strictFile(content);
		if (next.header.id !== this.#header.id) unavailable();
		if (principalWriteContext.getStore()?.principal !== this && this.#header.modelRequestJournal &&
			JSON.stringify(next.header.modelRequestJournal) !== JSON.stringify(this.#header.modelRequestJournal)) unavailable();
		this.#header = next.header;
		this.#entries = next.entries;
		if (this.#leafId !== null && !this.#entries.some(entry => entry.id === this.#leafId &&
			entry.type !== "model_request_metadata" && entry.type !== "model_request_registry")) this.#leafId = null;
		this.#expectedSize = Buffer.byteLength(content);
	}

	ensureDirSync(dir: string): void {
		if (path.resolve(dir) !== this.#sessionDir) this.#assertPath(dir);
		this.#storage.ensureDirSync(dir);
	}
	existsSync(fpath: string): boolean { return this.#storage.existsSync(fpath); }
	statSync(fpath: string): SessionStorageStat { return this.#storage.statSync(fpath); }
	listFilesSync(dir: string, pattern: string): string[] { return this.#storage.listFilesSync(dir, pattern); }
	exists(fpath: string): Promise<boolean> { return this.#storage.exists(fpath); }
	readText(fpath: string): Promise<string> { return this.#storage.readText(fpath); }
	readTextSync(fpath: string): string { return this.#storage.readTextSync(fpath); }
	readTextSlices(fpath: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		return this.#storage.readTextSlices(fpath, prefixBytes, suffixBytes);
	}
	hasAssistantTurn(fpath: string): Promise<boolean> { return this.#storage.hasAssistantTurn(fpath); }
	writeTextSync(fpath: string, content: string, options?: SessionStorageWriteOptions): void {
		this.#assertPath(fpath);
		this.#storage.writeTextSync(fpath, content, options);
		if (path.resolve(fpath) === this.#sessionFile) this.#refreshCommitted();
	}
	writeLinesSync(fpath: string, lines: readonly string[], options?: SessionStorageWriteOptions): void {
		this.#assertPath(fpath);
		this.#storage.writeLinesSync(fpath, lines, options);
		if (path.resolve(fpath) === this.#sessionFile) this.#refreshCommitted();
	}
	writeText(fpath: string, content: string): Promise<void> {
		this.#assertPath(fpath);
		return this.#enqueue(async () => {
			await this.#storage.writeText(fpath, content);
			if (path.resolve(fpath) === this.#sessionFile) this.#refreshCommitted();
		});
	}
	writeTextAtomic(fpath: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		this.#assertPath(fpath);
		return this.#enqueue(async () => {
			await this.#storage.writeTextAtomic(fpath, content, options);
			if (path.resolve(fpath) === this.#sessionFile) this.#refreshCommitted();
		});
	}
	writeLinesAtomic(fpath: string, lines: readonly string[], options?: WriteTextAtomicOptions): Promise<void> {
		this.#assertPath(fpath);
		return this.#enqueue(async () => {
			await this.#storage.writeLinesAtomic(fpath, lines, options);
			if (path.resolve(fpath) === this.#sessionFile) this.#refreshCommitted();
		});
	}
	async updateSessionTitle(fpath: string, update: SessionTitleUpdate): Promise<void> {
		this.#assertPath(fpath);
		await this.#enqueue(() => this.#storage.updateSessionTitle(fpath, update));
		if (path.resolve(fpath) === this.#sessionFile) this.#header = { ...this.#header, title: update.title, titleSource: update.source };
	}
	rename(fpath: string, nextPath: string): Promise<void> {
		this.#assertPath(fpath); this.#assertPath(nextPath);
		return this.#storage.rename(fpath, nextPath);
	}
	unlink(fpath: string): Promise<void> { this.#assertPath(fpath); return this.#storage.unlink(fpath); }
	deleteSessionWithArtifacts(fpath: string): Promise<void> {
		this.#assertPath(fpath); return this.#storage.deleteSessionWithArtifacts(fpath);
	}
	deleteSessionWithArtifactsIf(fpath: string, shouldDelete: (content: string) => boolean): Promise<boolean> {
		this.#assertPath(fpath); return this.#storage.deleteSessionWithArtifactsIf(fpath, shouldDelete);
	}
	withSessionFileLockSync<T>(fpath: string, operation: () => T): T {
		this.#assertPath(fpath); return this.#storage.withSessionFileLockSync(fpath, operation);
	}
	claimSession(sessionId: string, sessionFile: string): (() => void) | null {
		this.#assertLive();
		if (sessionId !== this.getSessionId() || path.resolve(sessionFile) !== this.#sessionFile) unavailable();
		return () => { this.seal(); };
	}
	openWriter(fpath: string, options?: { flags?: "a" | "w"; onError?: (error: Error) => void }): SessionStorageWriter {
		this.#assertPath(fpath);
		if (path.resolve(fpath) !== this.#sessionFile) return this.#storage.openWriter(fpath, options);
		this.#assertLive();
		if (!this.#writer?.isOpen()) this.#writer = this.#storage.openWriter(fpath, options);
		return this.#writer;
	}
	drain(): Promise<void> { return this.flush(); }

	getSessionDir(): string { return this.#sessionDir; }

	resetToNewSession(options?: NewSessionOptions, forcedSessionFile?: string, cwd?: string): string {
		if (this.#session && !this.#closed) unavailable();
		this.#revoke("required-revoked");
		void this.#writer?.close().catch(error => this.#fail(error));
		this.#lease.release();
		liveCellsById.delete(this.#header.id);
		liveCellsByPath.delete(this.#sessionFile);
		const next = new FileSessionPrincipalImpl({
			cwd: cwd ?? this.#header.cwd, sessionDir: options?.sessionDir ?? this.#sessionDir, sessionFile: forcedSessionFile,
		});
		next.#header = { ...next.#header, parentSession: options?.parentSession,
			providerPromptCacheKey: options?.providerPromptCacheKey, additionalDirectories: options?.additionalDirectories };
		this.#adopt(next);
		return this.#sessionFile;
	}

	moveOffSessionFile(_reason: "open-elsewhere" | "replaced" | "contested"): string {
		if (this.#header.modelRequestJournal || this.#header.modelRequestRegistry) unavailable();
		const header = this.#header;
		const entries = this.#entries;
		this.resetToNewSession({ parentSession: header.id, providerPromptCacheKey: header.providerPromptCacheKey ?? header.id });
		this.#header = { ...this.#header, title: header.title, titleSource: header.titleSource };
		this.#entries = entries;
		return this.#sessionFile;
	}

	async fork(): Promise<{ oldSessionFile: string; newSessionFile: string }> {
		if (this.#header.modelRequestJournal || this.#header.modelRequestRegistry) unavailable();
		await this.flush();
		const oldSessionFile = this.#sessionFile;
		const newSessionFile = this.moveOffSessionFile("replaced");
		return { oldSessionFile, newSessionFile };
	}
	getSessionId(): string { return this.#header.id; }
	getSessionFile(): string { return this.#sessionFile; }
	getHeader(): Readonly<SessionHeader> { return structuredClone(this.#header); }
	getEntries(): readonly SessionEntry[] { return structuredClone(this.#entries); }
	getEntry(id: string): Readonly<SessionEntry> | undefined {
		const entry = this.#entries.find(candidate => candidate.id === id);
		return entry === undefined ? undefined : structuredClone(entry);
	}
	getLeafId(): string | null { return this.#leafId; }
	branch(leafId: string | null): void {
		this.#assertLive();
		if (leafId !== null && !this.#entries.some(entry => entry.id === leafId &&
			entry.type !== "model_request_metadata" && entry.type !== "model_request_registry")) unavailable();
		this.#leafId = leafId;
	}

	#assertLive(): void {
		if (this.#sealed || this.#fault) unavailable();
		if (this.#closed) {
			if (this.#header.modelRequestJournal || this.#header.modelRequestRegistry) unavailable();
			const lease = tryAcquireSessionLease(this.#header.id);
			if (!lease) unavailable();
			this.#lease = lease;
			this.#closed = false;
		}
		if (liveCellsByPath.get(this.#sessionFile) !== this || liveCellsById.get(this.#header.id) !== this) unavailable();
	}

	#guardRemove(): void {
		if (this.#header.modelRequestJournal || this.#header.modelRequestRegistry) unavailable();
		this.#revoke("required-revoked");
	}

	#guardBody(content: string): void {
		this.#assertLive();
		if (principalWriteContext.getStore()?.principal === this && content === this.#allowedBody) return;
		const next = strictFile(content);
		if (next.header.id !== this.#header.id) unavailable();
		if (this.#header.modelRequestJournal || this.#header.modelRequestRegistry) {
			if (JSON.stringify(next.header.modelRequestJournal) !== JSON.stringify(this.#header.modelRequestJournal) ||
				JSON.stringify(next.header.modelRequestRegistry) !== JSON.stringify(this.#header.modelRequestRegistry)) unavailable();
			const protectedEntries = this.#entries.filter(entry =>
				entry.type === "model_request_metadata" || entry.type === "model_request_registry" || sourceEntry(entry));
			for (const entry of protectedEntries) {
				if (!next.entries.some(candidate => candidate.id === entry.id && JSON.stringify(candidate) === JSON.stringify(entry))) unavailable();
			}
			for (const entry of next.entries) {
				if ((entry.type === "model_request_metadata" || entry.type === "model_request_registry" || sourceEntry(entry)) &&
					!this.#entries.some(candidate => candidate.id === entry.id && JSON.stringify(candidate) === JSON.stringify(entry))) unavailable();
			}
		} else if (next.header.modelRequestJournal || next.header.modelRequestRegistry ||
			next.entries.some(entry => entry.type === "model_request_metadata" || entry.type === "model_request_registry")) unavailable();
		// Validation is not a commit. The canonical projection changes only after
		// the backend has made this exact body visible.
	}

	#guardAppend(line: string): void {
		this.#assertLive();
		const value: unknown = JSON.parse(line);
		if (!value || typeof value !== "object" || !("type" in value) ||
			value.type === "session" || value.type === "title" ||
			value.type === "model_request_metadata" || value.type === "model_request_registry" ||
			((this.#header.modelRequestJournal || this.#header.modelRequestRegistry) && (value.type === "model_usage" ||
				value.type === "message" && "message" in value && value.message !== null &&
				typeof value.message === "object" && "role" in value.message && value.message.role === "assistant"))) unavailable();
	}

	#enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const generation = this.#generation;
		const result = this.#queue.then(async () => {
			this.#assertLive();
			if (generation !== this.#generation) unavailable();
			return operation();
		});
		this.#queue = result.then(() => {}, error => { if (generation === this.#generation) this.#fail(error); });
		return result;
	}

	#fail(error: unknown): void {
		this.#fault ??= toError(error);
		this.#revoke("required-faulted");
	}

	#revoke(state: "required-revoked" | "required-faulted"): void {
		this.#generation++;
		for (const family of this.#families) family.state = state;
		if (!this.#session) return;
		const session = sessionStates.get(this.#session);
		if (session) session.family.state = state;
	}

	async #publish(header: SessionHeader, entries: readonly SessionEntry[]): Promise<void> {
		this.#assertLive();
		const body = serializeTitleSlot({ title: header.title, source: header.titleSource, updatedAt: header.timestamp }) +
			`${JSON.stringify(header)}\n${entries.map(entry => `${JSON.stringify(entry)}\n`).join("")}`;
		this.#allowedBody = body;
		const generation = this.#generation;
		const filename = this.#sessionFile;
		try {
			const pending = principalWriteContext.run({ principal: this, body }, () => this.#storage.writeTextAtomic(filename, body, {
				expectedSize: this.#expectedSize, requireAtomicReplace: true,
				commitGuard: () => !this.#closed && !this.#fault && this.#generation === generation && this.#sessionFile === filename,
			}));
			await pending;
			await this.#storage.drain();
			const visible = strictFile(await this.#storage.readText(this.#sessionFile));
			const expected = strictFile(body);
			if (JSON.stringify(visible) !== JSON.stringify(expected)) unavailable();
			this.#header = visible.header;
			this.#entries = visible.entries;
			this.#expectedSize = Buffer.byteLength(body);
		} finally { this.#allowedBody = undefined; }
	}

	ensureOnDisk(): Promise<void> {
		return this.#enqueue(() => this.#publish(this.#header, this.#entries));
	}
	async flush(): Promise<void> {
		await this.#queue;
		await this.#storage.drain();
		if (this.#fault) throw this.#fault;
	}
	flushSync(): void {
		this.#assertLive();
		const body = serializeTitleSlot({ title: this.#header.title, source: this.#header.titleSource, updatedAt: this.#header.timestamp }) +
			`${JSON.stringify(this.#header)}\n${this.#entries.map(entry => `${JSON.stringify(entry)}\n`).join("")}`;
		this.#allowedBody = body;
		try {
			principalWriteContext.run({ principal: this, body }, () =>
				this.#storage.writeTextSync(this.#sessionFile, body, { expectedSize: this.#expectedSize, requireAtomicReplace: true }));
			this.#expectedSize = Buffer.byteLength(body);
		} finally { this.#allowedBody = undefined; }
	}
	seal(): void { this.#sealed = true; this.#revoke("required-revoked"); }
	releaseRetainedEntries(): void { this.seal(); }
	async close(): Promise<void> {
		if (this.#closed) return;
		if (this.#session) await closeJournalSession(this.#session);
		this.#revoke("required-revoked");
		await this.flush();
		await this.#writer?.close();
		this.#closed = true;
		this.#lease.release();
		if (this.#header.modelRequestJournal || this.#header.modelRequestRegistry) {
			liveCellsById.delete(this.#header.id);
			liveCellsByPath.delete(this.#sessionFile);
		}
	}
	async setSessionFile(sessionFile: string): Promise<void> {
		if (path.resolve(sessionFile) === this.#sessionFile) return;
		if (liveCellsByPath.has(path.resolve(sessionFile))) unavailable();
		await this.close();
		const next = requireCell(openFileJournalCell({ cwd: this.#header.cwd, sessionDir: path.dirname(sessionFile), sessionFile }));
		this.#adopt(next);
	}

	#adopt(next: FileSessionPrincipalImpl): void {
		if (next === this) return;
		const previous = this.#sessionFile;
		liveCellsById.delete(this.#header.id);
		liveCellsByPath.delete(previous);
		this.#families.clear(); this.#agentFamilies.clear();
		if (!this.#header.modelRequestJournal && !this.#header.modelRequestRegistry) principalFileGuards.delete(previous);
		this.#header = next.#header;
		this.#entries = next.#entries;
		this.#leafId = next.#leafId;
		this.#sessionFile = next.#sessionFile;
		this.#sessionDir = next.#sessionDir;
		this.#expectedSize = next.#expectedSize;
		this.#lease = next.#lease;
		this.#writer = undefined;
		this.#closed = false;
		this.#sealed = false;
		this.#fault = undefined;
		this.#session = undefined;
		this.#queue = Promise.resolve();
		liveCellsById.set(this.#header.id, this);
		liveCellsByPath.set(this.#sessionFile, this);
		principalFileGuards.set(this.#sessionFile, {
			body: content => this.#guardBody(content), append: line => this.#guardAppend(line),
			remove: () => this.#guardRemove(), committed: () => this.#refreshCommitted(),
		});
		next.#closed = true;
	}
	async newSession(options?: NewSessionOptions): Promise<string> {
		await this.close();
		this.resetToNewSession(options);
		return this.#sessionFile;
	}
	async moveTo(newCwd: string, targetSessionDir?: string): Promise<void> {
		this.#assertLive();
		if (this.#header.modelRequestJournal || this.#header.modelRequestRegistry || this.#relocating) unavailable();
		const resolvedCwd = path.resolve(newCwd);
		const dir = path.resolve(targetSessionDir ?? this.#sessionDir);
		const source = this.#sessionFile;
		const dest = path.join(dir, path.basename(source));
		if (resolvedCwd === this.#header.cwd && dir === this.#sessionDir) return;
		const assertSource = (): void => {
			const id = readSessionHeaderIdSync(source);
			if (id !== undefined && id !== this.#header.id) unavailable();
		};
		let destination: { id: string; lease: FileLockHandle } | undefined;
		const claimDestination = (): void => {
			const id = readSessionHeaderIdSync(dest);
			if (id === undefined || id === this.#header.id || id === destination?.id) return;
			if (liveCellsById.has(id)) unavailable();
			const lease = tryAcquireSessionLease(id);
			if (!lease) unavailable();
			destination?.lease.release();
			destination = { id, lease };
		};
		assertSource();
		if (dest !== source) { guardFileRemoval(dest); claimDestination(); }
		this.#revoke("required-revoked");
		this.#relocating = { source, dest };
		let moved = false;
		try {
			await this.flush();
			await this.#writer?.close();
			this.#writer = undefined;
			fs.mkdirSync(dir, { recursive: true });
			const existed = fs.existsSync(source);
			if (existed && dest !== source) {
				assertSource(); claimDestination();
				principalFileGuards.set(dest, {
					body: content => this.#guardBody(content), append: line => this.#guardAppend(line),
					remove: () => this.#guardRemove(), committed: () => this.#refreshCommitted(),
				});
				try { await fs.promises.rename(source, dest); }
				catch (error) {
					if (!hasFsCode(error, "EXDEV")) throw error;
					await moveFileAcrossDevices(source, dest);
				}
				moved = true;
			}
			if (dest !== source) {
				liveCellsByPath.delete(source);
				principalFileGuards.delete(source);
				this.#sessionFile = dest;
				this.#sessionDir = dir;
				liveCellsByPath.set(dest, this);
				principalFileGuards.set(dest, {
					body: content => this.#guardBody(content), append: line => this.#guardAppend(line),
					remove: () => this.#guardRemove(), committed: () => this.#refreshCommitted(),
				});
				if (!moved) this.#expectedSize = null;
			}
			const header: SessionHeader = { ...this.#header, cwd: resolvedCwd,
				additionalDirectories: this.#header.additionalDirectories?.filter(root => root !== resolvedCwd),
				previousSessionFiles: existed && dest !== source
					? [...new Set([...(this.#header.previousSessionFiles ?? []), path.resolve(source)])]
					: this.#header.previousSessionFiles };
			this.#relocating = undefined;
			if (existed || this.#entries.some(entry => entry.type === "message" && entry.message.role === "assistant")) {
				await this.#publish(header, this.#entries);
			} else this.#header = header;
		} finally {
			this.#relocating = undefined;
			if (this.#sessionFile !== dest) principalFileGuards.delete(dest);
			destination?.lease.release();
		}
	}
	appendMessage(message: Extract<ModelRequestSourceInput, {kind: "assistant"}>["args"][0]): string {
		if (this.#session) unavailable();
		this.#assertLive();
		const id = randomUUID();
		this.#entries.push({ type: "message", id, parentId: this.#entries.at(-1)?.id ?? null, timestamp: new Date().toISOString(), message });
		this.flushSync();
		return id;
	}
	appendModelUsage(...args: Extract<ModelRequestSourceInput, {kind: "model_usage"}>["args"]): string | undefined {
		if (this.#session || args[1].sessionId !== this.getSessionId()) unavailable();
		const id = randomUUID();
		this.#entries.push({ type: "model_usage", id, parentId: args[1].parentId, timestamp: new Date().toISOString(), ...args[0] });
		this.flushSync();
		return id;
	}

	async compose(root: FileSessionPrincipalImpl, binding: ModelRequestJournalLeaseBinding, execution: ModelRequestExecution): Promise<JournalSession> {
		const executionState = requireExecution(execution);
		const family = executionState.family;
		this.#assertLive();
		root.#assertLive();
		if (family.binding !== binding || binding.rootSessionId !== root.getSessionId() ||
			familyState(family) === "required-revoked" || familyState(family) === "required-faulted") unavailable();
		if (this.#session) {
			const state = sessionStates.get(this.#session);
			if (!state || state.closed || state.family !== family || state.binding !== binding || state.root !== root) unavailable();
			await withVerifiedModelRequestJournalLeases(binding, state.registryId, async scope => {
				scope.assertActive(); this.assertSession(this.#session!, execution); root.#readRegistry();
			});
			return this.#session;
		}
		let parentFamily: ExecutionFamily | undefined;
		if (this !== root) {
			parentFamily = executionState.agent.parentId === undefined ? undefined : root.#agentFamilies.get(executionState.agent.parentId);
			if (!root.#session || !parentFamily?.cell || parentFamily.binding !== binding ||
				familyState(parentFamily) !== "required-ready" ||
				executionState.agent.depth < 1) unavailable();
			parentFamily.cell.#assertLive();
		} else if (executionState.agent.kind !== "main" || executionState.agent.depth !== 0 ||
			executionState.agent.parentId !== undefined) unavailable();
		const id = root.#header.modelRequestRegistry?.registryId ?? registryId();
		try {
			return await withVerifiedModelRequestJournalLeases(binding, id, async scope => {
				this.#assertLive(); root.#assertLive(); scope.assertActive();
				const generation = this.#generation;
				const rootGeneration = root.#generation;
				if (!root.#header.modelRequestRegistry) {
					if (root.#entries.some(sourceEntry)) unavailable();
					await root.#publish({ ...root.#header, modelRequestRegistry: {
						schemaVersion: 1, registryId: id, registryEpoch: randomUUID(), rootSessionId: root.getSessionId(),
					} }, root.#entries);
				}
				const registry = root.#readRegistry();
				if (registry.registryId !== id || registry.rootSessionId !== root.getSessionId()) unavailable();
				const ownerId = randomUUID();
				const journalId = this.#header.modelRequestJournal?.journalId ?? randomUUID();
				const journalEpoch = randomUUID();
				const records: ModelRequestRegistryEntry["record"][] = [
					{ event: "member-registered", sessionId: this.getSessionId(), parentSessionId: parentFamily?.cell?.getSessionId() ?? null,
						ownerId, persistenceOwnerRef: this.#persistenceOwnerRef, journalRef: this.getSessionId(), journalEpoch, firstSeq: 1 },
					{ event: "owner-registered", ownerId, sessionId: this.getSessionId(), journalEpoch },
				];
				await root.#appendRegistry(records);
				scope.assertActive();
				const through = root.#readRegistry().throughSeq;
				const receipt: RegistrationReceipt = { cell: this, root, generation, rootGeneration, binding, scope,
					registrationThroughSeq: through, ownerId, journalId, journalEpoch };
				if (this.#entries.some(sourceEntry) && !this.#header.modelRequestJournal) unavailable();
				const descriptor: ModelRequestJournalDescriptor = {
					schemaVersion: 1, journalId, sessionId: this.getSessionId(),
					epochs: [...(this.#header.modelRequestJournal?.epochs ?? []), { journalOwnerId: ownerId, journalEpoch }],
				};
				await this.#publish({ ...this.#header, modelRequestJournal: descriptor }, this.#entries);
				this.#assertReceipt(receipt);
				const owner = Object.freeze({}) as ModelRequestJournalOwner;
				const session = Object.freeze({}) as JournalSession;
				const state: JournalSessionState = { cell: this, root, binding, family, owner, generation, rootGeneration,
					registryId: id, registryEpoch: registry.registryEpoch, journalId, journalEpoch, ownerId, throughSeq: 0, closed: false };
				sessionStates.set(session, state);
				ownerSessions.set(owner, session);
				this.#session = session;
				family.cell = this; family.root = root; family.session = session;
				this.#assertReceipt(receipt);
				if (parentFamily) family.ancestors.push(parentFamily, ...parentFamily.ancestors);
				this.#families.add(family); root.#families.add(family);
				for (const ancestor of family.ancestors) if (ancestor.cell) ancestor.cell.#families.add(family);
				root.#agentFamilies.set(executionState.agent.id, family);
				family.state = "required-ready";
				return session;
			});
		} catch (error) { this.#fail(error); family.state = "required-faulted"; throw error; }
	}

	#assertReceipt(receipt: RegistrationReceipt): void {
		receipt.scope.assertActive();
		this.#assertLive(); receipt.root.#assertLive();
		const source = strictFile(this.#storage.readTextSync(this.#sessionFile));
		if (source.header.id !== this.#header.id ||
			JSON.stringify(source.header.modelRequestJournal) !== JSON.stringify(this.#header.modelRequestJournal)) unavailable();
		if (receipt.cell !== this || receipt.binding !== receipt.scope.binding ||
			receipt.generation !== this.#generation || receipt.rootGeneration !== receipt.root.#generation ||
			receipt.scope.rootSessionId !== receipt.root.getSessionId() ||
			receipt.root.#readRegistry().throughSeq < receipt.registrationThroughSeq ||
			this.#header.modelRequestJournal?.journalId !== receipt.journalId ||
			this.#header.modelRequestJournal.epochs.at(-1)?.journalEpoch !== receipt.journalEpoch) unavailable();
	}

	#readRegistry(): { registryId: string; registryEpoch: string; rootSessionId: string; throughSeq: number } {
		const file = strictFile(this.#storage.readTextSync(this.#sessionFile));
		if (file.header.id !== this.#header.id ||
			JSON.stringify(file.header.modelRequestRegistry) !== JSON.stringify(this.#header.modelRequestRegistry)) unavailable();
		return readRegistrySnapshot(file.header, file.entries);
	}

	async #appendRegistry(records: readonly ModelRequestRegistryEntry["record"][]): Promise<void> {
		const registry = this.#readRegistry();
		let seq = registry.throughSeq;
		const entries: ModelRequestRegistryEntry[] = records.map(record => ({
			type: "model_request_registry", id: randomUUID(), parentId: null, timestamp: new Date().toISOString(),
			schemaVersion: 1, registryId: registry.registryId, registryEpoch: registry.registryEpoch, seq: ++seq, record,
		}));
		readRegistrySnapshot(this.#header, [...this.#entries, ...entries]);
		await this.#publish(this.#header, [...this.#entries, ...entries]);
		if (this.#readRegistry().throughSeq !== seq) unavailable();
	}

	assertSession(session: JournalSession, execution: ModelRequestExecution): JournalSessionState {
		const state = sessionStates.get(session);
		this.#assertLive();
		if (!state || state.closed || state.cell !== this || this.#session !== session ||
			familyState(state.family) !== "required-ready" ||
			state.generation !== this.#generation || state.rootGeneration !== state.root.#generation ||
			requireExecution(execution).family !== state.family || state.family.binding !== state.binding ||
			this.#header.modelRequestJournal?.journalId !== state.journalId ||
			this.#header.modelRequestJournal.epochs.at(-1)?.journalEpoch !== state.journalEpoch) unavailable();
		state.root.#assertLive();
		return state;
	}

	appendModelRequestMetadata(owner: ModelRequestJournalOwner, record: ModelRequestLifecycleRecord): Promise<ModelRequestJournalAck> {
		const session = ownerSessions.get(owner);
		const state = session && sessionStates.get(session);
		if (!session || !state || state.cell !== this) unavailable();
		return this.#append(session, record);
	}
	appendModelRequestSource(owner: ModelRequestJournalOwner, source: ModelRequestSourceInput, link: ModelRequestSourceLinkInput): Promise<ModelRequestJournalAck> {
		const session = ownerSessions.get(owner);
		const state = session && sessionStates.get(session);
		if (!session || !state || state.cell !== this) unavailable();
		return this.#append(session, undefined, source, link);
	}

	async #append(session: JournalSession, record?: ModelRequestLifecycleRecord, source?: ModelRequestSourceInput, link?: ModelRequestSourceLinkInput): Promise<ModelRequestJournalAck> {
		const state = sessionStates.get(session);
		if (!state || state.cell !== this || state.closed) unavailable();
		return this.#enqueue(async () => {
			try {
				return await withVerifiedModelRequestJournalLeases(state.binding, state.registryId, async scope => {
					this.#assertLive(); state.root.#assertLive(); scope.assertActive();
					if (state.closed || state.generation !== this.#generation || state.rootGeneration !== state.root.#generation) unavailable();
					const records: SessionEntry[] = [...this.#entries];
					let sourceEntryId: string | null = null;
					let metadataRecord: ModelRequestMetadataEntry["record"];
					if (source !== undefined && link !== undefined) {
						const sourceCopy = structuredClone(source);
						const linkCopy: unknown = structuredClone(link);
						assertModelRequestSourceLinkInput(linkCopy);
						if (sourceCopy.kind !== linkCopy.sourceKind) unavailable();
						sourceEntryId = randomUUID();
						const base = { id: sourceEntryId, timestamp: new Date().toISOString(), parentId: this.#leafId };
						if (sourceCopy.kind === "assistant") {
							if (sourceCopy.args.length !== 1 || sourceCopy.args[0].role !== "assistant") unavailable();
							records.push({ type: "message", ...base, message: sourceCopy.args[0] });
						} else {
							if (sourceCopy.args.length !== 2 || sourceCopy.args[1].sessionId !== this.getSessionId()) unavailable();
							if (sourceCopy.args[1].parentId !== null && !this.#entries.some(entry =>
								entry.id === sourceCopy.args[1].parentId && entry.type !== "model_request_metadata" &&
								entry.type !== "model_request_registry")) unavailable();
							records.push({ type: "model_usage", ...base, ...sourceCopy.args[0], parentId: sourceCopy.args[1].parentId });
						}
						metadataRecord = { ...linkCopy, sourceSessionId: this.getSessionId(), sourceEntryId };
					} else {
						const copy: unknown = structuredClone(record);
						assertModelRequestLifecycleRecord(copy, this.getSessionId(), state.ownerId);
						if (copy.event !== "logical-result" && copy.rootSessionId !== state.root.getSessionId()) unavailable();
						metadataRecord = copy;
					}
					const seq = state.throughSeq + 1;
					if (!Number.isSafeInteger(seq)) unavailable();
					const metadata: ModelRequestMetadataEntry = {
						type: "model_request_metadata", id: randomUUID(), parentId: null, timestamp: new Date().toISOString(),
						schemaVersion: 1, journalId: state.journalId, sessionId: this.getSessionId(),
						journalOwnerId: state.ownerId, journalEpoch: state.journalEpoch, seq, record: metadataRecord,
					};
					records.push(metadata);
					await this.#publish(this.#header, records);
					scope.assertActive();
					if (sourceEntryId !== null && source !== undefined &&
						(source.kind === "assistant" || source.args[1].parentId === this.#leafId)) this.#leafId = sourceEntryId;
					const visible = validateModelRequestJournal([this.#header, ...this.#entries]);
					if (visible.throughSeqByEpoch.get(state.journalEpoch) !== seq ||
						!visible.metadataEntries.some(entry => JSON.stringify(entry) === JSON.stringify(metadata))) unavailable();
					state.throughSeq = seq;
					return Object.freeze({ schemaVersion: 1, journalId: state.journalId, sessionId: this.getSessionId(),
						journalOwnerId: state.ownerId, journalEpoch: state.journalEpoch, throughSeq: seq,
						metadataEntryId: metadata.id, sourceEntryId });
				});
			} catch (error) { this.#fail(error); throw error; }
		});
	}

	async closeSession(session: JournalSession): Promise<void> {
		const state = sessionStates.get(session);
		if (!state || state.cell !== this) unavailable();
		if (state.closed) return;
		state.family.state = "required-revoked";
		for (const family of this.#families) family.state = "required-revoked";
		for (const family of this.#families) {
			if (family.session && family.session !== session && family.cell) await family.cell.closeSession(family.session);
		}
		await this.flush();
		try {
			await withVerifiedModelRequestJournalLeases(state.binding, state.registryId, async scope => {
				scope.assertActive();
				await state.root.#appendRegistry([
					{ event: "member-closed", sessionId: this.getSessionId(), journalEpoch: state.journalEpoch, throughSeq: state.throughSeq, outcome: "closed" },
					{ event: "owner-closed", ownerId: state.ownerId, sessionId: this.getSessionId(), journalEpoch: state.journalEpoch, throughSeq: state.throughSeq, outcome: "closed" },
				]);
				scope.assertActive();
			});
		} finally { state.closed = true; this.#revoke("required-revoked"); }
	}
}
Object.freeze(FileSessionPrincipalImpl.prototype);

export function openFileJournalCell(input: ExistingFileSessionOpenInput): FileJournalCell {
	if (!input || typeof input !== "object" || typeof input.cwd !== "string" ||
		Reflect.ownKeys(input).some(key => typeof key !== "string" || !["cwd", "sessionDir", "sessionFile", "sessionId"].includes(key))) unavailable();
	if (input.sessionFile !== undefined) {
		const existing = liveCellsByPath.get(path.resolve(input.sessionFile));
		if (existing) {
			if (input.sessionId !== undefined && input.sessionId !== existing.getSessionId()) unavailable();
			return existing;
		}
	}
	return new FileSessionPrincipalImpl(input);
}

export function composeJournalSession(input: Readonly<{
	cell: FileJournalCell; root: FileJournalCell; binding: ModelRequestJournalLeaseBinding; execution: ModelRequestExecution;
}>): Promise<JournalSession> {
	assertJournalExecutionIdentity(input.execution);
	return requireCell(input.cell).compose(requireCell(input.root), input.binding, input.execution);
}

export function appendJournalMetadata(session: JournalSession, execution: ModelRequestExecution, record: ModelRequestLifecycleRecord): Promise<ModelRequestJournalAck> {
	const state = sessionStates.get(session);
	if (!state) unavailable();
	state.cell.assertSession(session, execution);
	return state.cell.appendModelRequestMetadata(state.owner, record);
}

export function appendJournalSource(session: JournalSession, execution: ModelRequestExecution, source: ModelRequestSourceInput, link: ModelRequestSourceLinkInput): Promise<ModelRequestJournalAck> {
	const state = sessionStates.get(session);
	if (!state) unavailable();
	state.cell.assertSession(session, execution);
	return state.cell.appendModelRequestSource(state.owner, source, link);
}

export function closeJournalSession(session: JournalSession): Promise<void> {
	const state = sessionStates.get(session);
	if (!state) unavailable();
	return state.cell.closeSession(session);
}
