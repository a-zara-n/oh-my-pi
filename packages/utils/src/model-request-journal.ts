import type { ModelRequestPurpose } from "./model-request-data";
import type {
	ModelRequestJournalAck,
	ModelRequestJournalModelRef,
	ModelRequestJournalDescriptor,
	ModelRequestLifecycleRecord,
	ModelRequestMetadataEntry,
	ModelRequestSourceLink,
	ModelRequestSourceLinkInput,
	ModelRequestSourceProvenance,
	SessionEntry,
} from "./session-entries";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ENTRY_ID = /^[A-Za-z0-9_-]+$/;
const MODEL_TOKEN = /^[A-Za-z0-9_.:/@+-]+$/;
const PURPOSES: Record<ModelRequestPurpose, true> = {
	main: true, subagent: true, advisor: true, "side-channel": true, compaction: true,
	"branch-summary": true, handoff: true, judge: true, memory: true, title: true,
	"auto-repair": true, commit: true, annotate: true, "speech-enhance": true,
	"cache-warm": true, embedding: true, other: true,
};

const ENTRY_TYPES: Record<SessionEntry["type"], true> = {
	message: true, model_usage: true, model_request_metadata: true, model_request_registry: true, thinking_level_change: true,
	model_change: true, service_tier_change: true, compaction: true, branch_summary: true,
	custom: true, custom_message: true, label: true, title_change: true, ttsr_injection: true,
	session_init: true, mode_change: true, credential_pin: true, reset_boundary: true,
};

function object(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype: unknown = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Reflect.ownKeys(value);
	return actual.length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

export function isCanonicalModelRequestId(value: unknown): value is string {
	return typeof value === "string" && UUID.test(value);
}

function entryId(value: unknown): value is string {
	return typeof value === "string" && ENTRY_ID.test(value);
}

function integer(value: unknown, minimum: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function ids(value: unknown, nonempty: boolean): value is readonly string[] {
	if (!Array.isArray(value) || (nonempty && value.length === 0)) return false;
	const seen = new Set<string>();
	for (const id of value) {
		if (!isCanonicalModelRequestId(id) || seen.has(id)) return false;
		seen.add(id);
	}
	return true;
}

function modelToken(value: unknown): value is string {
	return typeof value === "string" && MODEL_TOKEN.test(value) && !value.includes("://");
}

function modelRef(value: unknown): value is ModelRequestJournalModelRef {
	return object(value) && keys(value, ["provider", "id", "api"]) &&
		modelToken(value.provider) && modelToken(value.id) && modelToken(value.api);
}

function purpose(value: unknown): value is ModelRequestPurpose {
	return typeof value === "string" && Object.hasOwn(PURPOSES, value);
}

function outcome(value: unknown): boolean {
	if (!object(value)) return false;
	switch (value.kind) {
		case "not-sent":
		case "response-ended":
			return keys(value, ["kind"]);
		case "request-failed":
			return keys(value, ["kind", "sent", "transportClosed"]) &&
				(value.sent === "no" || value.sent === "maybe") && typeof value.transportClosed === "boolean";
		case "response-failed":
			return keys(value, ["kind", "transportClosed"]) && typeof value.transportClosed === "boolean";
		default:
			return false;
	}
}

export function isModelRequestJournalDescriptor(value: unknown, sessionId?: string): value is ModelRequestJournalDescriptor {
	if (!object(value) || !keys(value, ["schemaVersion", "journalId", "sessionId", "epochs"]) ||
		value.schemaVersion !== 1 || !isCanonicalModelRequestId(value.journalId) || !entryId(value.sessionId) ||
		(sessionId !== undefined && value.sessionId !== sessionId) || !Array.isArray(value.epochs) || value.epochs.length === 0) return false;
	const owners = new Set<string>();
	const epochs = new Set<string>();
	for (const epoch of value.epochs) {
		if (!object(epoch) || !keys(epoch, ["journalOwnerId", "journalEpoch"]) ||
			!isCanonicalModelRequestId(epoch.journalOwnerId) || !isCanonicalModelRequestId(epoch.journalEpoch) ||
			owners.has(epoch.journalOwnerId) || epochs.has(epoch.journalEpoch)) return false;
		owners.add(epoch.journalOwnerId);
		epochs.add(epoch.journalEpoch);
	}
	return true;
}

export function isModelRequestLifecycleRecord(value: unknown, sessionId?: string, journalOwnerId?: string): value is ModelRequestLifecycleRecord {
	if (!object(value) || value.schemaVersion !== 1 || !isCanonicalModelRequestId(value.requestId) ||
		!entryId(value.sessionId) || (sessionId !== undefined && value.sessionId !== sessionId)) return false;
	if (value.event === "logical-result") {
		return keys(value, ["schemaVersion", "event", "requestId", "resultId", "sessionId", "journalOwnerId", "usageAttemptIds", "sourceDisposition"]) &&
			isCanonicalModelRequestId(value.resultId) && isCanonicalModelRequestId(value.journalOwnerId) &&
			(journalOwnerId === undefined || value.journalOwnerId === journalOwnerId) &&
			ids(value.usageAttemptIds, value.sourceDisposition === "expected") &&
			(value.sourceDisposition === "expected" || (value.sourceDisposition === "none" && value.usageAttemptIds.length === 0));
	}
	const common = ["schemaVersion", "coreAttemptId", "requestId", "coreRetryOf", "rootSessionId", "sessionId", "purpose", "modelRef", "event", "atMs"];
	if (!isCanonicalModelRequestId(value.coreAttemptId) ||
		!(value.coreRetryOf === null || (isCanonicalModelRequestId(value.coreRetryOf) && value.coreRetryOf !== value.coreAttemptId)) ||
		!entryId(value.rootSessionId) || !purpose(value.purpose) || !modelRef(value.modelRef) || !integer(value.atMs, 0)) return false;
	switch (value.event) {
		case "decision":
			return keys(value, [...common, "decision"]) && (value.decision === "pass" || value.decision === "deny" || value.decision === "allow");
		case "send-intent":
			return keys(value, common);
		case "transport-outcome":
			return keys(value, [...common, "outcome"]) && outcome(value.outcome);
		default:
			return false;
	}
}

export function isModelRequestSourceProvenance(value: unknown): value is ModelRequestSourceProvenance {
	if (!object(value)) return false;
	switch (value.kind) {
		case "wire": {
			if (!keys(value, ["kind", "requestIds", "attemptIds", "usageAttemptIds"]) ||
				!ids(value.requestIds, true) || !ids(value.attemptIds, true) || !ids(value.usageAttemptIds, true)) return false;
			const attemptIds = value.attemptIds;
			return value.usageAttemptIds.every(id => attemptIds.includes(id));
		}
		case "non-wire":
			return keys(value, ["kind", "reason"]) && (value.reason === "cache" || value.reason === "local");
		case "unresolved":
			return keys(value, ["kind"]);
		default:
			return false;
	}
}

function linkFields(value: Record<string, unknown>): boolean {
	return value.schemaVersion === 1 && (value.sourceKind === "assistant" || value.sourceKind === "model_usage") &&
		(value.resultId === null || isCanonicalModelRequestId(value.resultId)) &&
		isModelRequestSourceProvenance(value.provenance) &&
		(value.provenance.kind !== "wire" || isCanonicalModelRequestId(value.resultId));
}

export function isModelRequestSourceLinkInput(value: unknown): value is ModelRequestSourceLinkInput {
	return object(value) && keys(value, ["schemaVersion", "sourceKind", "resultId", "provenance"]) && linkFields(value);
}

export function isModelRequestSourceLink(value: unknown, sessionId?: string): value is ModelRequestSourceLink {
	return object(value) && keys(value, ["schemaVersion", "sourceKind", "sourceSessionId", "sourceEntryId", "resultId", "provenance"]) &&
		linkFields(value) && entryId(value.sourceSessionId) && entryId(value.sourceEntryId) &&
		(sessionId === undefined || value.sourceSessionId === sessionId);
}

export function isModelRequestMetadataEntry(value: unknown): value is ModelRequestMetadataEntry {
	if (!object(value) || !keys(value, ["type", "id", "parentId", "timestamp", "schemaVersion", "journalId", "sessionId", "journalOwnerId", "journalEpoch", "seq", "record"]) ||
		value.type !== "model_request_metadata" || !entryId(value.id) || value.parentId !== null ||
		typeof value.timestamp !== "string" || !Number.isFinite(Date.parse(value.timestamp)) ||
		new Date(value.timestamp).toISOString() !== value.timestamp || value.schemaVersion !== 1 ||
		!isCanonicalModelRequestId(value.journalId) || !entryId(value.sessionId) ||
		!isCanonicalModelRequestId(value.journalOwnerId) || !isCanonicalModelRequestId(value.journalEpoch) || !integer(value.seq, 1)) return false;
	return isModelRequestLifecycleRecord(value.record, value.sessionId, value.journalOwnerId) || isModelRequestSourceLink(value.record, value.sessionId);
}

export function isModelRequestJournalAck(value: unknown): value is ModelRequestJournalAck {
	return object(value) && keys(value, ["schemaVersion", "journalId", "sessionId", "journalOwnerId", "journalEpoch", "throughSeq", "metadataEntryId", "sourceEntryId"]) &&
		value.schemaVersion === 1 && isCanonicalModelRequestId(value.journalId) && entryId(value.sessionId) &&
		isCanonicalModelRequestId(value.journalOwnerId) && isCanonicalModelRequestId(value.journalEpoch) &&
		integer(value.throughSeq, 1) && entryId(value.metadataEntryId) && (value.sourceEntryId === null || entryId(value.sourceEntryId));
}

function invalid(): never {
	// Never echo persisted data (which may contain credentials) into an error.
	throw new Error("Invalid model request journal");
}

export function assertModelRequestLifecycleRecord(value: unknown, sessionId?: string, journalOwnerId?: string): asserts value is ModelRequestLifecycleRecord {
	if (!isModelRequestLifecycleRecord(value, sessionId, journalOwnerId)) invalid();
}

export function assertModelRequestSourceLinkInput(value: unknown): asserts value is ModelRequestSourceLinkInput {
	if (!isModelRequestSourceLinkInput(value)) invalid();
}

export interface ModelRequestJournalValidation {
	readonly descriptor: ModelRequestJournalDescriptor;
	readonly metadataEntries: readonly ModelRequestMetadataEntry[];
	/** Includes empty epochs, whose end is zero. */
	readonly throughSeqByEpoch: ReadonlyMap<string, number>;
}

/** Strict whole-snapshot validation, never a lenient successful prefix. */
export function validateModelRequestJournal(
	entries: readonly unknown[],
	options: { malformedRecords?: number; invalidHeader?: boolean } = {},
): ModelRequestJournalValidation {
	if ((options.malformedRecords ?? 0) !== 0 || options.invalidHeader) invalid();
	const header = entries[0];
	if (!object(header) || header.type !== "session" || typeof header.id !== "string" ||
		!isModelRequestJournalDescriptor(header.modelRequestJournal, header.id)) invalid();
	const descriptor = header.modelRequestJournal;
	const throughSeqByEpoch = new Map<string, number>();
	const epochIndices = new Map<string, number>();
	for (const [index, epoch] of descriptor.epochs.entries()) {
		throughSeqByEpoch.set(epoch.journalEpoch, 0);
		epochIndices.set(epoch.journalEpoch, index);
	}
	const metadataEntries: ModelRequestMetadataEntry[] = [];
	const sources = new Map<string, Record<string, unknown>>();
	const entryIds = new Set<string>([descriptor.sessionId]);
	let lastEpochIndex = 0;
	for (let position = 1; position < entries.length; position++) {
		const entry = entries[position];
		if (!object(entry) || typeof entry.type !== "string" || !Object.hasOwn(ENTRY_TYPES, entry.type) ||
			!entryId(entry.id) || entryIds.has(entry.id)) invalid();
		entryIds.add(entry.id);
		if (entry.type !== "model_request_metadata") {
			sources.set(entry.id, entry);
			continue;
		}
		if (!isModelRequestMetadataEntry(entry) || entry.journalId !== descriptor.journalId || entry.sessionId !== descriptor.sessionId) invalid();
		const index = epochIndices.get(entry.journalEpoch);
		if (index === undefined || index < lastEpochIndex || descriptor.epochs[index]?.journalOwnerId !== entry.journalOwnerId ||
			entry.seq !== (throughSeqByEpoch.get(entry.journalEpoch) ?? 0) + 1) invalid();
		lastEpochIndex = index;
		if (isModelRequestSourceLink(entry.record, descriptor.sessionId)) {
			const source = sources.get(entry.record.sourceEntryId);
			if (!source || (entry.record.sourceKind === "model_usage" ? source.type !== "model_usage" :
				source.type !== "message" || !object(source.message) || source.message.role !== "assistant")) invalid();
		}
		throughSeqByEpoch.set(entry.journalEpoch, entry.seq);
		metadataEntries.push(entry);
	}
	return { descriptor, metadataEntries, throughSeqByEpoch };
}
