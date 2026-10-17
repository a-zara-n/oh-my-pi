import * as fs from "node:fs";
import { tryAcquireSessionLease } from "@oh-my-pi/pi-utils/model-request-journal-composition";
import type {
	FileEntry,
	ModelRequestMetadataEntry,
	SessionHeader,
	SessionMessageEntry,
} from "@oh-my-pi/pi-utils/session-entries";

export const ISO = "2026-10-16T00:00:00.000Z";
export const EPOCH = "33333333-3333-4333-8333-333333333333";

export function userEntry(id: string, parentId: string | null = null): SessionMessageEntry {
	return { type: "message", id, parentId, timestamp: ISO,
		message: { role: "user", content: `message ${id}`, timestamp: 1 } };
}

export function fileEntries(cwd: string, managed: boolean): FileEntry[] {
	const header: SessionHeader = { type: "session", version: 3, id: crypto.randomUUID(), timestamp: ISO, cwd };
	if (!managed) return [header, userEntry("first")];
	// Real persisted-reader data, as in file-session-principal.test.ts. These
	// records do not issue an owner, install an authority, or fabricate readiness.
	const journalId = "11111111-1111-4111-8111-111111111111";
	const ownerId = "22222222-2222-4222-8222-222222222222";
	header.modelRequestJournal = { schemaVersion: 1, journalId, sessionId: header.id,
		epochs: [{ journalOwnerId: ownerId, journalEpoch: EPOCH }] };
	const metadata: ModelRequestMetadataEntry = {
		type: "model_request_metadata", id: "metadata1", parentId: null, timestamp: ISO,
		schemaVersion: 1, journalId, sessionId: header.id, journalOwnerId: ownerId, journalEpoch: EPOCH, seq: 1,
		record: {
			schemaVersion: 1, event: "decision", coreAttemptId: "44444444-4444-4444-8444-444444444444",
			requestId: "55555555-5555-4555-8555-555555555555", coreRetryOf: null,
			rootSessionId: header.id, sessionId: header.id, purpose: "main",
			modelRef: { provider: "openai", id: "gpt-5", api: "openai-responses" }, atMs: 1, decision: "pass",
		},
	};
	const assistant: SessionMessageEntry = {
		type: "message", id: "assistant1", parentId: null, timestamp: ISO,
		message: {
			role: "assistant", api: "openai-responses", provider: "openai", model: "gpt-5", stopReason: "stop",
			timestamp: 1, content: [{ type: "text", text: "persisted source" }],
			usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		},
	};
	const linked: ModelRequestMetadataEntry = {
		...metadata, id: "metadata2", seq: 2,
		record: { schemaVersion: 1, sourceKind: "assistant", sourceSessionId: header.id,
			sourceEntryId: assistant.id, resultId: null, provenance: { kind: "non-wire", reason: "cache" } },
	};
	return [header, metadata, assistant, linked, userEntry("first", assistant.id)];
}

if (process.argv[2] === "--foreign-append") {
	const [, , , file, sessionId, line] = process.argv;
	if (!file || !sessionId || !line) throw new Error("Missing foreign append fixture arguments");
	// The ordinary principal already owns the actual OS lease. The old/raw
	// writer deliberately bypasses that lease, exactly like a foreign binary.
	const unexpectedLease = tryAcquireSessionLease(sessionId);
	if (unexpectedLease) {
		unexpectedLease.release();
		throw new Error("Expected actual parent-held session lease contention");
	}
	fs.appendFileSync(file, line);
	console.log("FOREIGN_COMMITTED");
}
