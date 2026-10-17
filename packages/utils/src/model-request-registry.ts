import type { ModelRequestRegistryEntry, SessionEntry, SessionHeader } from "./session-entries";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isCanonicalModelRequestId(value: unknown): value is string {
	return typeof value === "string" && UUID.test(value);
}

function closedKeys(value: object, keys: readonly string[]): boolean {
	return Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function invalid(): never {
	// Never echo persisted data (which may contain credentials) into an error.
	throw new Error("Invalid model request registry");
}

/** Pure whole-history validation; this projection does not issue journal authority. */
export function validateModelRequestRegistry(header: SessionHeader, entries: readonly SessionEntry[]): Readonly<{
	registryId: string; registryEpoch: string; rootSessionId: string; throughSeq: number;
}> {
	const registry = header.modelRequestRegistry;
	if (!registry || !closedKeys(registry, ["schemaVersion", "registryId", "registryEpoch", "rootSessionId"]) ||
		(registry.schemaVersion !== 1 && registry.schemaVersion !== 2) || registry.rootSessionId !== header.id ||
		!/^jr_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(registry.registryId) ||
		!isCanonicalModelRequestId(registry.registryEpoch)) invalid();
	type Member = { record: Extract<ModelRequestRegistryEntry["record"], { event: "member-registered" }>;
		ownerRegistered: boolean; closed: boolean; ownerClosed: boolean; throughSeq?: number; outcome?: "closed" | "faulted" };
	const members = new Map<string, Member>();
	const owners = new Map<string, Member>();
	const active = new Map<string, Member>();
	let throughSeq = 0;
	// Schema 2 registration is one adjacent member/owner pair. Legacy history is not backfilled.
	let pendingMember: Member | undefined;
	for (const entry of entries) {
		if (entry.type !== "model_request_registry") {
			if (pendingMember) invalid();
			continue;
		}
		if (!closedKeys(entry, ["type", "id", "parentId", "timestamp", "schemaVersion", "registryId", "registryEpoch", "seq", "record"]) ||
			entry.parentId !== null || entry.schemaVersion !== registry.schemaVersion || entry.registryId !== registry.registryId ||
			entry.registryEpoch !== registry.registryEpoch || entry.seq !== ++throughSeq ||
			!Number.isSafeInteger(entry.seq) || typeof entry.timestamp !== "string" || !Number.isFinite(Date.parse(entry.timestamp))) invalid();
		const record = entry.record;
		if (!record || typeof record !== "object" || !isCanonicalModelRequestId(record.journalEpoch) ||
			typeof record.sessionId !== "string" || !/^[A-Za-z0-9_-]+$/.test(record.sessionId)) invalid();
		if (pendingMember && record.event !== "owner-registered") invalid();
		if (record.event === "member-registered") {
			if (!closedKeys(record, ["event", "sessionId", "parentSessionId", "ownerId", "persistenceOwnerRef", "journalRef", "journalEpoch", "firstSeq"]) ||
				!isCanonicalModelRequestId(record.ownerId) || !isCanonicalModelRequestId(record.persistenceOwnerRef) ||
				record.firstSeq !== 1 || record.journalRef !== record.sessionId ||
				members.has(record.journalEpoch) || owners.has(record.ownerId) || active.has(record.sessionId)) invalid();
			if (record.sessionId === header.id) {
				if (record.parentSessionId !== null) invalid();
			} else {
				const parent = record.parentSessionId === null ? undefined : active.get(record.parentSessionId);
				if (!parent?.ownerRegistered || parent.closed) invalid();
			}
			const member: Member = { record, ownerRegistered: false, closed: false, ownerClosed: false };
			members.set(record.journalEpoch, member); owners.set(record.ownerId, member); active.set(record.sessionId, member);
			if (entry.schemaVersion === 2) pendingMember = member;
		} else if (record.event === "owner-registered") {
			const member = owners.get(record.ownerId);
			const ownerKeys = entry.schemaVersion === 2 ?
				["event", "ownerId", "sessionId", "journalEpoch", "writerOwnerId"] :
				["event", "ownerId", "sessionId", "journalEpoch"];
			if (!closedKeys(record, ownerKeys) || !member ||
				member.record.sessionId !== record.sessionId || member.record.journalEpoch !== record.journalEpoch ||
				member.ownerRegistered || member.closed) invalid();
			if (entry.schemaVersion === 2 &&
				(pendingMember !== member || !("writerOwnerId" in record) ||
					typeof record.writerOwnerId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(record.writerOwnerId))) invalid();
			member.ownerRegistered = true;
			pendingMember = undefined;
		} else if (record.event === "member-closed") {
			const member = members.get(record.journalEpoch);
			if (!closedKeys(record, ["event", "sessionId", "journalEpoch", "throughSeq", "outcome"]) || !member?.ownerRegistered ||
				member.record.sessionId !== record.sessionId || member.closed ||
				!Number.isSafeInteger(record.throughSeq) || record.throughSeq < 0 ||
				(record.outcome !== "closed" && record.outcome !== "faulted")) invalid();
			member.closed = true; member.throughSeq = record.throughSeq; member.outcome = record.outcome;
			active.delete(record.sessionId);
		} else if (record.event === "owner-closed") {
			const member = owners.get(record.ownerId);
			if (!closedKeys(record, ["event", "ownerId", "sessionId", "journalEpoch", "throughSeq", "outcome"]) ||
				!member?.closed || member.ownerClosed || member.record.sessionId !== record.sessionId ||
				member.record.journalEpoch !== record.journalEpoch || member.throughSeq !== record.throughSeq ||
				member.outcome !== record.outcome) invalid();
			member.ownerClosed = true;
		} else invalid();
	}
	if (pendingMember) invalid();
	if (header.modelRequestJournal) {
		for (const epoch of header.modelRequestJournal.epochs) {
			const member = members.get(epoch.journalEpoch);
			if (!member?.ownerRegistered || member.record.sessionId !== header.id ||
				member.record.ownerId !== epoch.journalOwnerId) invalid();
		}
	}
	return { ...registry, throughSeq };
}
