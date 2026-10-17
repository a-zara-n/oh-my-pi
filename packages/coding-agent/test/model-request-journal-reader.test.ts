import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { BlobStore } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import {
	isModelRequestJournalAck,
	isModelRequestLifecycleRecord,
	isModelRequestSourceLinkInput,
	validateModelRequestJournal,
} from "@oh-my-pi/pi-utils/model-request-journal";
import type { FileEntry,
	ModelRequestLifecycleRecord,
	ModelRequestMetadataEntry,
	ModelRequestRegistryEntry,
	ModelRequestRegistryRecord,
	SessionHeader,
	SessionMessageEntry, } from "@oh-my-pi/pi-utils/session-entries";
import { loadEntriesFromFileStream } from "@oh-my-pi/pi-utils/session-file-reader";
import {
	loadEntriesFromFile,
	loadModelRequestJournalFromFile,
	loadSessionFile,
	resolveBlobRefsInEntries,
} from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { migrateSessionEntries } from "@oh-my-pi/pi-utils/session-migrations";
import { prepareEntryForPersistence } from "@oh-my-pi/pi-coding-agent/session/session-persistence";
import { serializeTitleSlot } from "@oh-my-pi/pi-utils/session-title-slot";
import { TempDir } from "@oh-my-pi/pi-utils";

const ISO = "2026-10-16T00:00:00.000Z";
const JOURNAL = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const EPOCH = "33333333-3333-4333-8333-333333333333";
const ATTEMPT = "44444444-4444-4444-8444-444444444444";
const REQUEST = "55555555-5555-4555-8555-555555555555";
const RESULT = "66666666-6666-4666-8666-666666666666";
const OWNER2 = "77777777-7777-4777-8777-777777777777";
const EPOCH2 = "88888888-8888-4888-8888-888888888888";
const header: SessionHeader = {
	type: "session", version: 3, id: "s1", timestamp: ISO, cwd: "/tmp",
	modelRequestJournal: { schemaVersion: 1, journalId: JOURNAL, sessionId: "s1", epochs: [{ journalOwnerId: OWNER, journalEpoch: EPOCH }] },
};
const decision: ModelRequestLifecycleRecord = {
	schemaVersion: 1, event: "decision", coreAttemptId: ATTEMPT, requestId: REQUEST, coreRetryOf: null,
	rootSessionId: "s1", sessionId: "s1", purpose: "main", modelRef: { provider: "openai", id: "gpt-5", api: "openai-responses" },
	atMs: 1, decision: "pass",
};
const metadata: ModelRequestMetadataEntry = {
	type: "model_request_metadata", id: "metadata1", parentId: null, timestamp: ISO,
	schemaVersion: 1, journalId: JOURNAL, sessionId: "s1", journalOwnerId: OWNER, journalEpoch: EPOCH, seq: 1, record: decision,
};
const assistant: SessionMessageEntry = {
	type: "message", id: "assistant1", parentId: null, timestamp: ISO,
	message: {
		role: "assistant", api: "openai-responses", provider: "openai", model: "gpt-5", stopReason: "stop", timestamp: 1,
		content: [{ type: "text", text: "PROMPT_KEY_CANARY_BODY" }],
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	},
};
const linked: ModelRequestMetadataEntry = {
	...metadata, id: "metadata2", seq: 2,
	record: { schemaVersion: 1, sourceKind: "assistant", sourceSessionId: "s1", sourceEntryId: assistant.id, resultId: null, provenance: { kind: "non-wire", reason: "cache" } },
};

async function persist(file: string, entries: readonly unknown[]): Promise<void> {
	await Bun.write(file, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
}

describe("managed model request journal persisted reader boundary", () => {
	it("preserves canonical header/metadata through separate small and streaming readers and serialization", async () => {
		using dir = TempDir.createSync("@model-request-reader-");
		const file = path.join(dir.path(), "session.jsonl");
		const blobs = new BlobStore(path.join(dir.path(), "blobs"));
		const entries: FileEntry[] = [structuredClone(header), structuredClone(metadata), structuredClone(assistant), structuredClone(linked)];
		const persisted = entries.map(entry => prepareEntryForPersistence(entry, blobs));
		expect(persisted[1]).toBe(entries[1]);
		expect(persisted[3]).toBe(entries[3]);
		expect(JSON.stringify(persisted[3])).not.toContain("PROMPT_KEY_CANARY_BODY");
		await Bun.write(file, `${serializeTitleSlot({ title: "Managed", source: "user", updatedAt: ISO })}\n${persisted.map(entry => JSON.stringify(entry)).join("\n")}\n`);
		const ordinary = await loadEntriesFromFile(file);
		const streaming = await loadEntriesFromFileStream(file);
		expect(streaming.entries).toEqual(ordinary);
		expect(ordinary[0]).toMatchObject({ modelRequestJournal: header.modelRequestJournal });
		expect(ordinary[1]).toEqual(metadata);
		expect(ordinary[3]).toEqual(linked);
		await resolveBlobRefsInEntries(ordinary, blobs);
		migrateSessionEntries(ordinary);
		expect(ordinary[1]).toEqual(metadata);
		expect(ordinary[3]).toEqual(linked);
		const strict = await loadModelRequestJournalFromFile(file);
		expect(strict.throughSeqByEpoch.get(EPOCH)).toBe(2);
		expect(strict.metadataEntries).toEqual([metadata, linked]);
	});

	it.each([1, 2] as const)("retains exact registry schema %s through canonical readers, migration and persistence serialization", async schemaVersion => {
		using dir = TempDir.createSync("@model-request-registry-reader-");
		const file = path.join(dir.path(), "session.jsonl");
		const blobs = new BlobStore(path.join(dir.path(), "blobs"));
		const registryId = `jr_${"0".repeat(26)}`;
		const registryEpoch = REQUEST;
		const root: SessionHeader = { ...structuredClone(header), modelRequestRegistry: {
			schemaVersion, registryId, registryEpoch, rootSessionId: "s1",
		} };
		const records: ModelRequestRegistryRecord[] = [
			{ event: "member-registered", sessionId: "s1", parentSessionId: null, ownerId: OWNER,
				persistenceOwnerRef: RESULT, journalRef: "s1", journalEpoch: EPOCH, firstSeq: 1 },
			{ event: "owner-registered", ownerId: OWNER, sessionId: "s1", journalEpoch: EPOCH, writerOwnerId: "writer_shared" },
			{ event: "member-closed", sessionId: "s1", journalEpoch: EPOCH, throughSeq: 1, outcome: "closed" },
			{ event: "owner-closed", ownerId: OWNER, sessionId: "s1", journalEpoch: EPOCH, throughSeq: 1, outcome: "closed" },
		];
		const registry = records.map<ModelRequestRegistryEntry>((record, index) => {
			const common = { type: "model_request_registry" as const, id: `registry_${index}`, parentId: null,
				timestamp: ISO, registryId, registryEpoch, seq: index + 1 };
			return schemaVersion === 2 ? { ...common, schemaVersion: 2, record } :
				{ ...common, schemaVersion: 1, record: record.event === "owner-registered" ?
					{ event: record.event, ownerId: record.ownerId, sessionId: record.sessionId, journalEpoch: record.journalEpoch } : record };
		});
		const entries: FileEntry[] = [root, ...registry, structuredClone(metadata)];
		const persisted = entries.map(entry => prepareEntryForPersistence(entry, blobs));
		expect(persisted).toEqual(entries);
		await persist(file, persisted);
		const bytes = await readFile(file, "utf8");
		const ordinary = await loadEntriesFromFile(file);
		const streaming = await loadEntriesFromFileStream(file);
		const loaded = await loadSessionFile(file);
		expect(ordinary).toEqual(entries);
		expect(streaming.entries).toEqual(entries);
		expect(loaded.entries).toEqual(entries);
		migrateSessionEntries(ordinary);
		expect(ordinary).toEqual(entries);
		expect((await loadModelRequestJournalFromFile(file)).metadataEntries).toEqual([metadata]);
		expect(`${ordinary.map(entry => JSON.stringify(entry)).join("\n")}\n`).toBe(bytes);
		expect(bytes.includes("writerOwnerId")).toBe(schemaVersion === 2);
		if (schemaVersion === 2) {
			const nonadjacent: FileEntry[] = [root, registry[0]!, {
				type: "custom", id: "interposed", parentId: null, timestamp: ISO, customType: "correlation",
			}, ...registry.slice(1), structuredClone(metadata)];
			await persist(file, nonadjacent);
			const interposedBytes = await readFile(file, "utf8");
			await expect(loadEntriesFromFile(file)).rejects.toThrow("Invalid model request registry");
			await expect(loadSessionFile(file)).rejects.toThrow("Invalid model request registry");
			await expect(loadModelRequestJournalFromFile(file)).rejects.toThrow("Invalid model request registry");
			const rawStream = await loadEntriesFromFileStream(file);
			expect(() => migrateSessionEntries(rawStream.entries)).toThrow("Invalid model request registry");
			expect(await readFile(file, "utf8")).toBe(interposedBytes);
		}
	});

	it("rejects mixed registry history in the canonical journal reader without rewriting persisted data", async () => {
		using dir = TempDir.createSync("@model-request-registry-mixed-");
		const file = path.join(dir.path(), "session.jsonl");
		const root: SessionHeader = { ...structuredClone(header), modelRequestRegistry: {
			schemaVersion: 2, registryId: `jr_${"0".repeat(26)}`, registryEpoch: REQUEST, rootSessionId: "s1",
		} };
		const common = { type: "model_request_registry", parentId: null, timestamp: ISO,
			registryId: root.modelRequestRegistry?.registryId, registryEpoch: REQUEST };
		await persist(file, [root,
			{ ...common, id: "member", seq: 1, schemaVersion: 2, record: { event: "member-registered", sessionId: "s1",
				parentSessionId: null, ownerId: OWNER, persistenceOwnerRef: RESULT, journalRef: "s1", journalEpoch: EPOCH, firstSeq: 1 } },
			{ ...common, id: "owner", seq: 2, schemaVersion: 1, record: { event: "owner-registered", ownerId: OWNER,
				sessionId: "s1", journalEpoch: EPOCH } },
		]);
		const bytes = await readFile(file, "utf8");
		await expect(loadModelRequestJournalFromFile(file)).rejects.toThrow("Invalid model request registry");
		expect(await readFile(file, "utf8")).toBe(bytes);
	});

	it("retains the ordinary lenient legacy reader while rejecting malformed managed snapshots", async () => {
		using dir = TempDir.createSync("@model-request-corrupt-");
		const file = path.join(dir.path(), "session.jsonl");
		const corruptBytes = `${JSON.stringify(header)}\n${JSON.stringify(metadata)}\n{BROKEN\n`;
		await Bun.write(file, corruptBytes);
		await expect(loadEntriesFromFile(file)).rejects.toThrow("Invalid model request journal");
		await expect(loadSessionFile(file)).rejects.toThrow("Invalid model request journal");
		await expect(loadModelRequestJournalFromFile(file)).rejects.toThrow("Invalid model request journal");
		await expect(loadEntriesFromFileStream(file)).rejects.toThrow("Invalid model request journal");
		expect(await readFile(file, "utf8")).toBe(corruptBytes);
		const legacyHeader: SessionHeader = { type: "session", version: 3, id: "legacy", timestamp: ISO, cwd: "/tmp" };
		await persist(file, [legacyHeader, assistant]);
		const legacyBytes = `${await readFile(file, "utf8")}{BROKEN\n`;
		await Bun.write(file, legacyBytes);
		const legacy = await loadEntriesFromFile(file);
		migrateSessionEntries(legacy);
		expect(legacy[0]).toEqual(legacyHeader);
		expect(JSON.stringify(legacy)).not.toContain("journalEpoch");
		expect((await loadSessionFile(file)).malformedRecords).toBe(1);
		const streamedLegacy = await loadEntriesFromFileStream(file);
		expect(streamedLegacy.entries).toEqual(legacy);
		expect(streamedLegacy.malformedRecords).toBe(1);
		expect(await readFile(file, "utf8")).toBe(legacyBytes);
	});

	it.each([
		'{"type":"model_request_metadata","id":',
		'{"id":"partial","ty\\u0070e":"model_request_metadata","record":',
		'{"type":"session","id":"partial","modelRequestJournal":',
		'{"type":"model_request_registry","record":',
	])("rejects an incomplete reserved top-level record in both physical readers: %s", async tail => {
		using dir = TempDir.createSync("@model-request-raw-hint-");
		const file = path.join(dir.path(), "session.jsonl");
		const plain: SessionHeader = { type: "session", version: 3, id: "legacy", timestamp: ISO, cwd: "/tmp" };
		const bytes = `${JSON.stringify(plain)}\n${tail}`;
		await Bun.write(file, bytes);
		await expect(loadSessionFile(file)).rejects.toThrow();
		await expect(loadEntriesFromFileStream(file)).rejects.toThrow();
		expect(await readFile(file, "utf8")).toBe(bytes);
	});

	it("does not treat nested payloads or quoted managed spellings as top-level history", async () => {
		using dir = TempDir.createSync("@model-request-ordinary-hints-");
		const file = path.join(dir.path(), "session.jsonl");
		const plain: SessionHeader = { type: "session", version: 3, id: "legacy", timestamp: ISO, cwd: "/tmp" };
		const ordinary: FileEntry = { type: "custom", id: "ordinary", parentId: null, timestamp: ISO,
			customType: "correlation", data: {
				nested: { type: "model_request_metadata", modelRequestJournal: {} },
				quoted: '{"type":"model_request_registry"}',
			} };
		const bytes = `${JSON.stringify(plain)}\n${JSON.stringify(ordinary)}\n{BROKEN\n`;
		await Bun.write(file, bytes);
		const small = await loadSessionFile(file);
		const streamed = await loadEntriesFromFileStream(file);
		expect(small.entries).toEqual([plain, ordinary]);
		expect(streamed.entries).toEqual(small.entries);
		expect(small.malformedRecords).toBe(1);
		expect(streamed.malformedRecords).toBe(1);
		expect(await readFile(file, "utf8")).toBe(bytes);
	});

	it.each([
		["gap", { ...metadata, seq: 2 }],
		["zero", { ...metadata, seq: 0 }],
		["fraction", { ...metadata, seq: 1.5 }],
		["unsafe", { ...metadata, seq: Number.MAX_SAFE_INTEGER + 1 }],
		["owner", { ...metadata, journalOwnerId: OWNER2 }],
		["epoch", { ...metadata, journalEpoch: EPOCH2 }],
		["session", { ...metadata, sessionId: "other" }],
		["parent", { ...metadata, parentId: assistant.id }],
		["schema", { ...metadata, schemaVersion: 2 }],
		["unknown-key", { ...metadata, body: "PROMPT_KEY_CANARY_BODY" }],
		["unknown-variant", { ...metadata, record: { ...decision, event: "future" } }],
		["uppercase-id", { ...metadata, journalId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }],
		["record-body", { ...metadata, record: { ...decision, body: "REJECTED_RECORD_CANARY" } }],
		["record-headers", { ...metadata, record: { ...decision, headers: { authorization: "REJECTED_RECORD_CANARY" } } }],
		["model-url", { ...metadata, record: { ...decision, modelRef: { ...decision.modelRef, baseUrl: "https://REJECTED_RECORD_CANARY" } } }],
	])("rejects persisted %s without accepting a prefix", async (_name, bad) => {
		using dir = TempDir.createSync("@model-request-reject-");
		const file = path.join(dir.path(), "session.jsonl");
		await persist(file, [header, bad]);
		const bytes = await readFile(file, "utf8");
		await expect(loadModelRequestJournalFromFile(file)).rejects.toThrow();
		expect(await readFile(file, "utf8")).toBe(bytes);
	});

	it("validates every epoch, preserves empty epochs, and rejects epoch rollback and duplicate seq", () => {
		const twoEpochHeader = { ...header, modelRequestJournal: { schemaVersion: 1, journalId: JOURNAL, sessionId: "s1", epochs: [{ journalOwnerId: OWNER, journalEpoch: EPOCH }, { journalOwnerId: OWNER2, journalEpoch: EPOCH2 }] } };
		const next = { ...metadata, id: "next", journalOwnerId: OWNER2, journalEpoch: EPOCH2 };
		expect(validateModelRequestJournal([twoEpochHeader, metadata]).throughSeqByEpoch.get(EPOCH2)).toBe(0);
		expect(validateModelRequestJournal([twoEpochHeader, metadata, next]).throughSeqByEpoch.get(EPOCH2)).toBe(1);
		expect(() => validateModelRequestJournal([twoEpochHeader, next, metadata])).toThrow();
		expect(() => validateModelRequestJournal([header, metadata, { ...metadata, id: "duplicate" }])).toThrow();
		expect(() => validateModelRequestJournal([twoEpochHeader, { ...metadata, seq: 2 }, next])).toThrow();
	});

	it("requires real preceding same-session sources of exactly the claimed kind", async () => {
		using dir = TempDir.createSync("@model-request-source-");
		const file = path.join(dir.path(), "session.jsonl");
		const link = { schemaVersion: 1, sourceKind: "assistant", sourceSessionId: "s1", sourceEntryId: assistant.id, resultId: null, provenance: { kind: "non-wire", reason: "local" } };
		for (const entries of [
			[header, { ...metadata, record: link }],
			[header, { ...metadata, record: link }, assistant],
			[header, assistant, { ...metadata, record: { ...link, sourceKind: "model_usage" } }],
			[header, assistant, { ...metadata, record: { ...link, sourceSessionId: "other" } }],
			[header, { ...assistant, message: { role: "user", content: "not an assistant" } }, { ...metadata, record: link }],
		]) {
			await persist(file, entries);
			await expect(loadModelRequestJournalFromFile(file)).rejects.toThrow();
		}
		const usage = { type: "model_usage", id: "usage1", parentId: null, timestamp: ISO, purpose: "judge", api: "openai-responses", provider: "openai", model: "gpt-5", usage: assistant.message.role === "assistant" ? assistant.message.usage : undefined, stopReason: "stop" };
		await persist(file, [header, usage, { ...metadata, record: { ...link, sourceKind: "model_usage", sourceEntryId: usage.id } }]);
		expect((await loadModelRequestJournalFromFile(file)).metadataEntries.length).toBe(1);
	});

	it("rejects canary-bearing fixture source links instead of returning a valid metadata prefix", async () => {
		using dir = TempDir.createSync("@model-request-link-canary-");
		const file = path.join(dir.path(), "session.jsonl");
		const link = {
			schemaVersion: 1, sourceKind: "assistant", sourceSessionId: "s1", sourceEntryId: assistant.id,
			resultId: null, provenance: { kind: "non-wire", reason: "cache" },
		};
		const canary = "REJECTED_SOURCE_LINK_CANARY";
		for (const record of [
			{ ...link, body: canary },
			{ ...link, provenance: { ...link.provenance, headers: { authorization: canary } } },
			{ ...link, provenance: { kind: "unresolved", error: canary } },
		]) {
			// Explicitly persisted corrupt reader fixtures are not issued-owner writes.
			await persist(file, [header, metadata, assistant, { ...linked, record }]);
			const bytes = await readFile(file, "utf8");
			await expect(loadModelRequestJournalFromFile(file)).rejects.toThrow();
			const streaming = await loadEntriesFromFileStream(file);
			expect(() => validateModelRequestJournal(streaming.entries, streaming)).toThrow();
			expect(await readFile(file, "utf8")).toBe(bytes);
		}
	});

	it("never migrates managed history by regenerating IDs or fabricating epochs", () => {
		const entries: FileEntry[] = [{ ...structuredClone(header), version: 1 }, structuredClone(metadata)];
		const before = structuredClone(entries);
		expect(() => migrateSessionEntries(entries)).toThrow();
		expect(entries).toEqual(before);
	});

	it("rejects malformed descriptors, duplicate identities, and unknown entry variants", () => {
		for (const descriptor of [
			{ ...header.modelRequestJournal, epochs: [] },
			{ ...header.modelRequestJournal, sessionId: "other" },
			{ ...header.modelRequestJournal, schemaVersion: 2 },
			{ ...header.modelRequestJournal, epochs: [{ journalOwnerId: OWNER, journalEpoch: EPOCH }, { journalOwnerId: OWNER, journalEpoch: EPOCH2 }] },
			{ ...header.modelRequestJournal, epochs: [{ journalOwnerId: OWNER, journalEpoch: EPOCH }, { journalOwnerId: OWNER2, journalEpoch: EPOCH }] },
		]) expect(() => validateModelRequestJournal([{ ...header, modelRequestJournal: descriptor }])).toThrow();
		expect(() => validateModelRequestJournal([header, metadata, metadata])).toThrow();
		expect(() => validateModelRequestJournal([header, { type: "future-entry", id: "future" }])).toThrow();
	});
});

describe("closed model request journal payloads", () => {
	it("rejects free-text additions, unsafe model refs, unknown enums, and invalid integer timestamps", () => {
		for (const extra of [{ body: "secret" }, { headers: { authorization: "secret" } }, { url: "https://secret" }, { error: "secret" }]) {
			expect(isModelRequestLifecycleRecord({ ...decision, ...extra })).toBe(false);
		}
		for (const bad of [
			{ ...decision, purpose: "made-up" }, { ...decision, atMs: 0.5 }, { ...decision, atMs: -1 },
			{ ...decision, coreRetryOf: ATTEMPT }, { ...decision, requestId: "not-a-uuid" },
			{ ...decision, modelRef: { provider: "openai", id: "gpt-5", api: "openai-responses", baseUrl: "https://secret" } },
			{ ...decision, modelRef: { provider: "openai", id: "free text body", api: "openai-responses" } },
			{ ...decision, event: "transport-outcome", outcome: { kind: "request-failed", sent: "yes", transportClosed: true } },
		]) expect(isModelRequestLifecycleRecord(bad)).toBe(false);
		const logical = { schemaVersion: 1, event: "logical-result", requestId: REQUEST, resultId: RESULT, sessionId: "s1", journalOwnerId: OWNER, usageAttemptIds: [ATTEMPT], sourceDisposition: "expected" };
		expect(isModelRequestLifecycleRecord(logical, "s1", OWNER)).toBe(true);
		expect(isModelRequestLifecycleRecord(logical, "s1", OWNER2)).toBe(false);
		expect(isModelRequestLifecycleRecord({ ...logical, sourceDisposition: "none" })).toBe(false);
	});

	it("requires nonempty, unique wire provenance and a real usage-attempt subset", () => {
		const input = { schemaVersion: 1, sourceKind: "assistant", resultId: RESULT, provenance: { kind: "wire", requestIds: [REQUEST], attemptIds: [ATTEMPT], usageAttemptIds: [ATTEMPT] } };
		expect(isModelRequestSourceLinkInput(input)).toBe(true);
		for (const bad of [
			{ ...input, resultId: null }, { ...input, sourceEntryId: assistant.id },
			{ ...input, provenance: { ...input.provenance, usageAttemptIds: [] } },
			{ ...input, provenance: { ...input.provenance, usageAttemptIds: [RESULT] } },
			{ ...input, provenance: { ...input.provenance, attemptIds: [ATTEMPT, ATTEMPT] } },
			{ ...input, provenance: { kind: "non-wire", reason: "unknown" } },
			{ ...input, provenance: { kind: "unresolved", error: "secret" } },
		]) expect(isModelRequestSourceLinkInput(bad)).toBe(false);
	});

	it("requires a positive closed ack rather than a caller entry ID", () => {
		const ack = { schemaVersion: 1, journalId: JOURNAL, sessionId: "s1", journalOwnerId: OWNER, journalEpoch: EPOCH, throughSeq: 1, metadataEntryId: metadata.id, sourceEntryId: null };
		expect(isModelRequestJournalAck(ack)).toBe(true);
		expect(isModelRequestJournalAck({ ...ack, throughSeq: 0 })).toBe(false);
		expect(isModelRequestJournalAck({ ...ack, error: "secret" })).toBe(false);
		expect(isModelRequestJournalAck(metadata.id)).toBe(false);
	});
});
