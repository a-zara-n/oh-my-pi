import { describe, expect, test } from "bun:test";
import { validateModelRequestRegistry } from "../src/model-request-registry";
import { CURRENT_SESSION_VERSION, type ModelRequestRegistryEntry, type ModelRequestRegistryRecord, type SessionEntry, type SessionHeader } from "../src/session-entries";
import { migrateToCurrentVersion } from "../src/session-migrations";

const ISO = "2026-10-17T00:00:00.000Z";
const REGISTRY = `jr_${"0".repeat(26)}`;
const WRITER = "writer_same-OS_lease";
const uuid = (value: number): string => `${value.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;

function header(schemaVersion: 1 | 2 = 2): SessionHeader {
	return { type: "session", version: CURRENT_SESSION_VERSION, id: "root", timestamp: ISO, cwd: "/tmp",
		modelRequestRegistry: { schemaVersion, registryId: REGISTRY, registryEpoch: uuid(1), rootSessionId: "root" } };
}

function registration(owner: number, epoch: number, sessionId = "root", parentSessionId: string | null = null): ModelRequestRegistryRecord[] {
	return [
		{ event: "member-registered", sessionId, parentSessionId, ownerId: uuid(owner), persistenceOwnerRef: uuid(2), journalRef: sessionId, journalEpoch: uuid(epoch), firstSeq: 1 },
		{ event: "owner-registered", ownerId: uuid(owner), sessionId, journalEpoch: uuid(epoch), writerOwnerId: WRITER },
	];
}

function closed(owner: number, epoch: number, sessionId = "root"): ModelRequestRegistryRecord[] {
	return [
		{ event: "member-closed", sessionId, journalEpoch: uuid(epoch), throughSeq: 0, outcome: "closed" },
		{ event: "owner-closed", ownerId: uuid(owner), sessionId, journalEpoch: uuid(epoch), throughSeq: 0, outcome: "closed" },
	];
}

function entries(records: readonly ModelRequestRegistryRecord[]): ModelRequestRegistryEntry[] {
	return records.map((record, index) => ({ type: "model_request_registry", id: `entry_${index}`, parentId: null,
		timestamp: ISO, schemaVersion: 2, registryId: REGISTRY, registryEpoch: uuid(1), seq: index + 1, record }));
}

// Intentionally malformed persisted snapshots cross the same typed boundary as a JSONL decoder.
function reject(snapshot: readonly unknown[], root: unknown = header()): void {
	expect(() => validateModelRequestRegistry(root as SessionHeader, snapshot as readonly SessionEntry[])).toThrow("Invalid model request registry");
}

function legacyEntries(): ModelRequestRegistryEntry[] {
	return entries([...registration(3, 4), ...closed(3, 4)]).map(entry => {
		const record = entry.record;
		return { ...entry, schemaVersion: 1, record: record.event === "owner-registered" ?
			{ event: record.event, ownerId: record.ownerId, sessionId: record.sessionId, journalEpoch: record.journalEpoch } : record };
	});
}

describe("canonical model request registry versions", () => {
	test("allows one writer to own distinct root, child and reopened epochs", () => {
		const history = entries([
			...registration(3, 4), ...registration(5, 6, "child", "root"), ...closed(5, 6, "child"),
			...registration(7, 8, "child", "root"), ...closed(7, 8, "child"), ...closed(3, 4), ...registration(9, 10),
		]);
		const result = validateModelRequestRegistry(header(), history);
		expect(result).toMatchObject({ registryId: REGISTRY, registryEpoch: uuid(1), rootSessionId: "root", throughSeq: 14 });
		const writers = history.flatMap(entry => entry.schemaVersion === 2 && entry.record.event === "owner-registered" ? [entry.record.writerOwnerId] : []);
		expect(writers).toEqual([WRITER, WRITER, WRITER, WRITER]);
	});

	test("reads and exports exact schema 1 four-record history without migration or inferred writer", () => {
		const history = legacyEntries();
		const file = [header(1), ...history];
		const before = JSON.stringify(file);
		expect(validateModelRequestRegistry(header(1), history).throughSeq).toBe(4);
		expect(migrateToCurrentVersion(file)).toBe(false);
		expect(JSON.stringify(file)).toBe(before);
		expect(before).not.toContain("writerOwnerId");
		expect(JSON.parse(before)).toEqual(file);
	});

	test("preserves historical incomplete v1 registration as readable, not upgraded proof", () => {
		const history = legacyEntries().slice(0, 1);
		expect(validateModelRequestRegistry(header(1), history).throughSeq).toBe(1);
		expect(history[0]?.schemaVersion).toBe(1);
	});

	test("rejects mixed, missing, unknown and descriptor-mismatched versions", () => {
		const current = entries(registration(3, 4));
		for (const schemaVersion of [undefined, 0, 3, "2", null]) {
			reject(current, { ...header(), modelRequestRegistry: { ...header().modelRequestRegistry, schemaVersion } });
			reject([{ ...current[0], schemaVersion }, current[1]]);
		}
		reject(current, header(1));
		reject(legacyEntries(), header());
		reject([current[0], { ...current[1], schemaVersion: 1 }]);
	});

	test("requires the closed writer-owner field only on current owner registration", () => {
		const current = entries(registration(3, 4));
		const owner = current[1];
		if (!owner) throw new Error("Missing owner fixture");
		for (const writerOwnerId of [undefined, null, 1, "", "x".repeat(129), "writer/path", "with space", "å"]) {
			reject([current[0], { ...owner, record: { ...owner.record, writerOwnerId } }]);
		}
		for (const writerOwnerId of ["a", "_", "-", "x".repeat(128)]) {
			const valid: ModelRequestRegistryEntry = { ...owner, schemaVersion: 2,
				record: { event: "owner-registered", ownerId: uuid(3), sessionId: "root", journalEpoch: uuid(4), writerOwnerId } };
			expect(validateModelRequestRegistry(header(), [current[0]!, valid]).throughSeq).toBe(2);
		}
		reject([{ ...current[0], record: { ...current[0]?.record, writerOwnerId: WRITER } }, owner]);
		for (const position of [2, 3]) {
			const all = entries([...registration(3, 4), ...closed(3, 4)]);
			reject(all.map((entry, index) => index === position ?
				{ ...entry, record: { ...entry.record, writerOwnerId: WRITER } } : entry));
		}
		const legacy = legacyEntries();
		reject([legacy[0], { ...legacy[1], record: { ...legacy[1]?.record, writerOwnerId: WRITER } }, ...legacy.slice(2)], header(1));
		reject([current[0], { ...owner, record: { ...owner.record, token: "NEVER_ECHO_CANARY" } }]);
	});

	test("rejects missing, nonadjacent, mismatched, duplicated and rebound registration pairs", () => {
		const current = entries(registration(3, 4));
		const member = current[0];
		const owner = current[1];
		if (!member || !owner) throw new Error("Missing registration fixtures");
		reject([member]);
		reject([owner]);
		reject([owner, member]);
		reject([member, { type: "custom", id: "ordinary", parentId: null, timestamp: ISO, customType: "correlation" }, owner]);
		for (const patch of [{ ownerId: uuid(5) }, { sessionId: "child" }, { journalEpoch: uuid(6) }]) {
			reject([member, { ...owner, record: { ...owner.record, ...patch } }]);
		}
		for (const writerOwnerId of [WRITER, "different_writer"]) {
			reject([...current, { ...owner, id: "duplicate", seq: 3, record: { ...owner.record, writerOwnerId } }]);
		}
		reject(entries([...registration(3, 4), ...registration(5, 6, "child", "root")]).filter((_, index) => index !== 1));
	});

	test("keeps owner UUID and global epoch uniqueness after logical close", () => {
		for (const next of [registration(3, 6), registration(5, 4)]) {
			reject(entries([...registration(3, 4), ...closed(3, 4), ...next]));
		}
		for (const patch of [{ ownerId: WRITER }, { journalEpoch: WRITER }, { persistenceOwnerRef: WRITER }]) {
			const current = entries(registration(3, 4));
			reject([{ ...current[0], record: { ...current[0]?.record, ...patch } }, current[1]]);
		}
	});

	test("requires exact source epoch ownership but does not add writer fields to the source descriptor", () => {
		const root = header();
		root.modelRequestJournal = { schemaVersion: 1, journalId: uuid(11), sessionId: "root", epochs: [{ journalOwnerId: uuid(3), journalEpoch: uuid(4) }] };
		const history = entries(registration(3, 4));
		expect(validateModelRequestRegistry(root, history).throughSeq).toBe(2);
		reject(history, { ...root, modelRequestJournal: { ...root.modelRequestJournal, epochs: [{ journalOwnerId: uuid(5), journalEpoch: uuid(4) }] } });
		reject(history, { ...root, modelRequestJournal: { ...root.modelRequestJournal, epochs: [{ journalOwnerId: uuid(3), journalEpoch: uuid(6) }] } });
	});
});
