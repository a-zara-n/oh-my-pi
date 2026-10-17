import { isEisdir, isEnoent, isEnotdir } from "./fs-error";
import type { FileEntry, RawFileEntry, SessionHeader } from "./session-entries";
import {
	parseTitleSlotFromContent,
	parseTitleSlotLine,
	type SessionTitleUpdate,
	titleUpdateFromSlot,
} from "./session-title-slot";
import { ConcatSink, parseJsonlLenient } from "./stream";

const LF = new Uint8Array([0x0a]);
const STREAM_YIELD_BYTES = 1 * 1024 * 1024;
const STREAM_YIELD_ENTRIES = 8_192;

export interface VisitEntriesFromFileStreamOptions {
	/** Stop after the visitor returns `false`. */
	shouldContinue?: () => boolean;
	/** Stop after this many valid or malformed JSONL records have been consumed. */
	maxRecords?: number;
	/** Read at most this many bytes from the file's current prefix. */
	maxBytes?: number;
	/** Yield to the macrotask queue after this many bytes have been consumed. */
	yieldEveryBytes?: number;
	/** Yield to the macrotask queue after this many entries have been visited. */
	yieldEveryEntries?: number;
	/** Called once for every malformed JSONL record skipped by the stream. */
	onMalformedRecord?: () => void;
	/** Rethrow missing source instead of visiting nothing (fork backstop). */
	throwIfMissing?: boolean;
	/**
	 * Called with each stream chunk's byte length as it is consumed. Lets
	 * callers derive the exact snapshot size without re-stating the file.
	 */
	onBytesConsumed?: (bytes: number) => void;
}

/** Parsed session entries plus corruption metadata needed by writable loaders. */
export interface SessionLoadResult {
	entries: FileEntry[];
	titleSlot: SessionTitleUpdate | undefined;
	malformedRecords: number;
	/** Byte length of the snapshot actually parsed, or `null` when the path did not exist. */
	sourceSize?: number | null;
	/** Whether non-empty session data was found without a valid leading session header. */
	invalidHeader: boolean;
}

function splitTitleSlot(content: string): { body: string; slot: SessionTitleUpdate | undefined } {
	const slot = titleUpdateFromSlot(parseTitleSlotFromContent(content));
	if (!slot) return { body: content, slot: undefined };
	const newlineIndex = content.indexOf("\n");
	return { body: content.slice(newlineIndex + 1), slot };
}

function isValidSessionHeader(entry: FileEntry | undefined): entry is SessionHeader {
	return entry?.type === "session" && typeof entry.id === "string";
}

function applyTitleSlot(entry: FileEntry | undefined, slot: SessionTitleUpdate | undefined): void {
	if (!slot || !isValidSessionHeader(entry)) return;
	if (slot.title && slot.title.length > 0) {
		entry.title = slot.title;
	} else {
		delete entry.title;
	}
	if (slot.source) {
		entry.titleSource = slot.source;
	} else {
		delete entry.titleSource;
	}
}

/** Parse session JSONL while stripping and folding the optional fixed title slot. */
export function parseSessionContent(content: string): SessionLoadResult {
	const { body, slot } = splitTitleSlot(content);
	let malformedRecords = 0;
	const entries = parseJsonlLenient<RawFileEntry>(body, {
		onMalformedRecord: () => {
			malformedRecords++;
		},
	}) as FileEntry[];
	applyTitleSlot(entries[0], slot);
	return {
		entries,
		titleSlot: slot,
		malformedRecords,
		sourceSize: Buffer.byteLength(content, "utf8"),
		invalidHeader: entries.length > 0 ? !isValidSessionHeader(entries[0]) : malformedRecords > 0,
	};
}

/** Upper bound on the bytes read to find a header: real headers (and the title slot before them) are far smaller. */
const SESSION_HEADER_READ_LIMIT = 1024 * 1024;

/**
 * The session id in `filePath`'s header, or `undefined` when there is no file
 * there or it does not start with a valid session header. Reads at most one
 * record and {@link SESSION_HEADER_READ_LIMIT} bytes.
 */
export async function readSessionHeaderId(filePath: string): Promise<string | undefined> {
	let id: string | undefined;
	try {
		await visitEntriesFromFileStream(
			filePath,
			entry => {
				if (isValidSessionHeader(entry)) id = entry.id;
				return false;
			},
			{ maxRecords: 1, maxBytes: SESSION_HEADER_READ_LIMIT },
		);
	} catch (err) {
		if (isEnoent(err) || isEnotdir(err) || isEisdir(err)) return undefined;
		throw err;
	}
	return id;
}

/** Parse session JSONL and visit each entry without retaining prior entries. */
export async function visitEntriesFromFileStream(
	filePath: string,
	visit: (entry: FileEntry) => void | boolean,
	options: VisitEntriesFromFileStreamOptions = {},
): Promise<SessionTitleUpdate | undefined> {
	let titleSlot: SessionTitleUpdate | undefined;
	let sawFirstLine = false;
	let sawFirstEntry = false;
	let bytesSinceYield = 0;
	let entriesSinceYield = 0;
	let recordsSeen = 0;
	const maxRecords = Math.max(0, options.maxRecords ?? Number.POSITIVE_INFINITY);
	let stopped = false;
	let visitorThrew = false;
	const yieldEveryBytes = Math.max(0, options.yieldEveryBytes ?? STREAM_YIELD_BYTES);
	const yieldEveryEntries = Math.max(0, options.yieldEveryEntries ?? STREAM_YIELD_ENTRIES);
	const maxBytes = Math.max(0, options.maxBytes ?? Number.POSITIVE_INFINITY);
	// Bytes, not text: a multibyte UTF-8 sequence straddling a chunk boundary
	// stays intact, and Bun.JSONL.parseChunk takes typed arrays directly. Only
	// the unconsumed remainder is held (≤ one record + a chunk), so the ≥8MiB
	// memory guard holds — the file is never fully loaded.
	const sink = new ConcatSink();
	const decoder = new TextDecoder();

	const yieldToMacrotask = async (): Promise<void> => {
		if (yieldEveryBytes === 0 && yieldEveryEntries === 0) return;
		const bytesReady = yieldEveryBytes === 0 || bytesSinceYield < yieldEveryBytes;
		const entriesReady = yieldEveryEntries === 0 || entriesSinceYield < yieldEveryEntries;
		if (bytesReady && entriesReady) {
			return;
		}
		bytesSinceYield = 0;
		entriesSinceYield = 0;
		await Bun.sleep(0);
	};

	const drain = async (): Promise<void> => {
		const view = sink.flush();
		if (!view) return;
		// Only newline-terminated bytes may reach the parser: a trailing fragment
		// in the same call turns an end-of-input `done` into a syntax error at the
		// preceding newline, which would then be miscounted as a malformed record.
		const lastNewline = view.lastIndexOf(0x0a);
		if (lastNewline === -1) return;
		let buffer: Uint8Array = view.subarray(0, lastNewline + 1);
		let consumed = 0;
		const advance = (count: number): void => {
			consumed += count;
			buffer = buffer.subarray(count);
		};
		while (buffer.length > 0 && !stopped) {
			if (recordsSeen >= maxRecords) {
				stopped = true;
				break;
			}
			const { values, error, read, done } = Bun.JSONL.parseChunk(buffer);
			for (const value of values) {
				if (recordsSeen >= maxRecords) {
					stopped = true;
					break;
				}
				if (options.shouldContinue && !options.shouldContinue()) {
					stopped = true;
					break;
				}
				const entry = value as FileEntry;
				if (!sawFirstEntry) {
					sawFirstEntry = true;
					applyTitleSlot(entry, titleSlot);
				}
				try {
					if (visit(entry) === false) {
						stopped = true;
						break;
					}
					recordsSeen++;
					entriesSinceYield++;
					if (recordsSeen >= maxRecords) {
						stopped = true;
						break;
					}
				} catch (err) {
					visitorThrew = true;
					throw err;
				}
				await yieldToMacrotask();
			}
			if (stopped) break;
			if (error) {
				// Malformed record: skip past the next newline and continue.
				const nextNewline = buffer.indexOf(0x0a, read);
				if (nextNewline === -1) break; // rest of the bad line not yet received
				let nonWhitespace = false;
				for (let index = read; index < nextNewline; index++) {
					const byte = buffer[index];
					if (byte !== 0x09 && byte !== 0x0d && byte !== 0x20) {
						nonWhitespace = true;
						break;
					}
				}
				if (nonWhitespace) options.onMalformedRecord?.();
				recordsSeen++;
				advance(nextNewline + 1);
				if (recordsSeen >= maxRecords) {
					stopped = true;
					break;
				}
				continue;
			}
			if (read === 0) break; // incomplete record awaiting more data
			advance(read);
			if (done) {
				advance(buffer.length);
				break;
			}
		}
		sink.consume(consumed);
	};

	try {
		const file = Bun.file(filePath);
		const source = Number.isFinite(maxBytes) ? file.slice(0, maxBytes) : file;
		for await (const chunk of source.stream()) {
			if (stopped) break;
			bytesSinceYield += chunk.byteLength;
			options.onBytesConsumed?.(chunk.byteLength);
			// Parsing before the chunk closes a line re-scans the unfinished record
			// on every chunk, which is quadratic for large records.
			if (chunk.lastIndexOf(0x0a) === -1) {
				// Skipping drain() also skips the only enforcement of the record cap,
				// so re-check it here: a delimiter-free file would otherwise be read
				// and buffered in full despite an exhausted budget.
				if (recordsSeen >= maxRecords) {
					stopped = true;
					break;
				}
				sink.append(chunk);
				await yieldToMacrotask();
				continue;
			}
			sink.append(chunk);
			// The optional fixed-width title slot is a physical first line that is
			// NOT JSON; peel it before the parser would (correctly) reject it. The
			// first line ends at a '\n' byte, so it is a complete UTF-8 sequence and
			// safe to decode. A non-slot first line is a real entry and is left for
			// the parser; a blank first line is left for the parser to skip.
			if (!sawFirstLine) {
				const buffered = sink.flush()!;
				const newline = buffered.indexOf(0x0a);
				if (newline !== -1) {
					sawFirstLine = true;
					const firstLine = decoder.decode(buffered.subarray(0, newline)).trim();
					if (firstLine) {
						const slot = parseTitleSlotLine(firstLine);
						if (slot) {
							titleSlot = titleUpdateFromSlot(slot);
							sink.consume(newline + 1);
						}
					}
				}
			}
			// parseChunk can leave a value unfinished even after a newline; the
			// sink keeps that remainder for the next chunk.
			await drain();
			await yieldToMacrotask();
		}
		// A trailing record without a final newline: terminate it so the parser
		// can complete it (readline yielded it; parseChunk needs the delimiter).
		if (!stopped && !sink.isEmpty) {
			sink.append(LF);
			await drain();
		}
	} catch (err) {
		if (visitorThrew) throw err;
		if (options.throwIfMissing && (isEnoent(err) || isEnotdir(err))) {
			throw err;
		}
		if (isEnoent(err)) {
			return undefined;
		}
		throw err;
	}

	return titleSlot;
}
/** Exported for testing — the ≥8MiB streaming path (works on any file size). */
export async function loadEntriesFromFileStream(
	filePath: string,
	options?: Pick<VisitEntriesFromFileStreamOptions, "throwIfMissing">,
): Promise<SessionLoadResult> {
	const entries: FileEntry[] = [];
	let malformedRecords = 0;
	let bytesConsumed = 0;
	const titleSlot = await visitEntriesFromFileStream(
		filePath,
		entry => {
			entries.push(entry);
		},
		{
			onMalformedRecord: () => {
				malformedRecords++;
			},
			throwIfMissing: options?.throwIfMissing,
			onBytesConsumed: bytes => {
				bytesConsumed += bytes;
			},
		},
	);
	return {
		entries,
		titleSlot,
		malformedRecords,
		sourceSize: bytesConsumed,
		invalidHeader: entries.length > 0 ? !isValidSessionHeader(entries[0]) : malformedRecords > 0,
	};
}
/** Exported for compaction.test.ts */
export function parseSessionEntries(content: string): FileEntry[] {
	return parseSessionContent(content).entries;
}
