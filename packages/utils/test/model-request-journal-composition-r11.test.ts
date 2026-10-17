import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ModelRequestAgent } from "../src/model-request-data";
import {
	appendJournalMetadata,
	appendJournalSource,
	assertJournalExecutionReady,
	beginJournalSend,
	closeJournalSession,
	composeJournalSession,
	createJournalExecution,
	deriveJournalExecution,
	endJournalSendStart,
	prepareJournalSend,
	type ClosedCoreAttemptIdentity,
	type FileJournalCell,
	type ModelRequestExecution,
	type OpaqueSendAdmission,
} from "../src/model-request-journal-composition";
import { tryAcquireRawModelRequestJournalFileLease } from "../src/model-request-journal-leases";
import { validateModelRequestRegistry } from "../src/model-request-registry";
import { validateModelRequestJournal } from "../src/model-request-journal";
import { parseSessionContent } from "../src/session-file-reader";
import type {
	ModelRequestJournalAck,
	ModelRequestLifecycleRecord,
	ModelRequestMetadataEntry,
	ModelRequestRegistryEntry,
	ModelRequestSourceInput,
} from "../src/session-entries";
import { R11JournalFixture, type ReadyPrincipal } from "./fixtures/model-request-journal-r11";

// DES-004 r11 §6.7.2g RC2/RC3/RC4: real File/native/binding consumers only.
// r12's proposed same-family checker/private-binding lifetime integration is not asserted here.
const mac = process.platform === "darwin" ? describe : describe.skip;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const mainAgent: ModelRequestAgent = { id: "display-agent", kind: "main", name: "display", depth: 0 };

function metadata(cell: FileJournalCell): ModelRequestMetadataEntry[] {
	return cell.getEntries().filter((entry): entry is ModelRequestMetadataEntry => entry.type === "model_request_metadata");
}
function registry(cell: FileJournalCell): ModelRequestRegistryEntry[] {
	return cell.getEntries().filter((entry): entry is ModelRequestRegistryEntry => entry.type === "model_request_registry");
}
function decision(cell: FileJournalCell, root: FileJournalCell): ModelRequestLifecycleRecord {
	return { schemaVersion: 1, event: "decision", coreAttemptId: randomUUID(), requestId: randomUUID(),
		coreRetryOf: null, rootSessionId: root.getSessionId(), sessionId: cell.getSessionId(), purpose: "main",
		modelRef: { provider: "openai", id: "fixture-model", api: "openai-completions" }, atMs: 1, decision: "pass" };
}
function epoch(cell: FileJournalCell): Readonly<{ journalOwnerId: string; journalEpoch: string }> {
	const value = cell.getHeader().modelRequestJournal?.epochs.at(-1);
	if (!value) throw new Error("Production composition did not publish an epoch");
	return value;
}
function assertAck(ack: ModelRequestJournalAck, cell: FileJournalCell, throughSeq: number): void {
	expect(Object.keys(ack).sort()).toEqual([
		"journalEpoch", "journalId", "journalOwnerId", "metadataEntryId", "schemaVersion", "sessionId", "sourceEntryId", "throughSeq",
	]);
	expect(ack).toMatchObject({ schemaVersion: 1, journalId: cell.getHeader().modelRequestJournal?.journalId,
		sessionId: cell.getSessionId(), ...epoch(cell), throughSeq });
	expect(metadata(cell).find(entry => entry.id === ack.metadataEntryId)).toMatchObject({
		journalOwnerId: ack.journalOwnerId, journalEpoch: ack.journalEpoch, seq: throughSeq,
	});
}
function rawOwner(): number {
	const uid = process.getuid?.();
	if (uid === undefined) throw new Error("Missing actual test uid");
	return uid;
}
function rootLock(fixture: R11JournalFixture, root: FileJournalCell): string {
	const id = root.getHeader().modelRequestRegistry?.registryId;
	if (!id) throw new Error("Missing production registry identity");
	return path.join(fixture.namespace, "accounting", `${id}.lock`);
}
function assertReleasedNow(filename: string): void {
	const acquired = tryAcquireRawModelRequestJournalFileLease(filename, "exclusive", rawOwner());
	if (!acquired) throw new Error("Actual root lease was not synchronously released");
	acquired.release();
}
function attempt(): ClosedCoreAttemptIdentity { return Object.freeze({ attemptId: randomUUID() }); }
async function rejected(operation: () => unknown): Promise<void> {
	await expect(Promise.resolve().then(operation)).rejects.toThrow();
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid persisted fixture object");
	return value as Record<string, unknown>;
}
function rewriteRecords(bytes: string, mutate: (record: Record<string, unknown>) => void): string {
	return `${bytes.trimEnd().split("\n").map(line => {
		const value: unknown = JSON.parse(line);
		const record = object(value);
		mutate(record);
		return JSON.stringify(record);
	}).join("\n")}\n`;
}

mac("r11 actual File logical principal ownership", () => {
	test("one authenticated writer maps distinct root/child/deep-child UUID owners and epochs, metadata, sources, and close batches", async () => {
		const fixture = new R11JournalFixture();
		try {
			const rootCell = fixture.open();
			await fixture.withBinding(rootCell, async binding => {
				const root = await fixture.ready(binding, rootCell);
				const child = await fixture.ready(binding, fixture.open(), root);
				const deep = await fixture.ready(binding, fixture.open(), child, mainAgent, rootCell);
				const principals = [root, child, deep];
				const owners = principals.map(principal => epoch(principal.cell).journalOwnerId);
				const epochs = principals.map(principal => epoch(principal.cell).journalEpoch);
				expect(new Set(owners).size).toBe(3);
				expect(new Set(epochs).size).toBe(3);
				for (const value of [...owners, ...epochs]) expect(value).toMatch(uuid);
				expect(owners).not.toContain(fixture.writerId);
				expect(rootCell.getHeader().modelRequestRegistry?.schemaVersion).toBe(2);
				for (const [index, principal] of principals.entries()) {
					assertJournalExecutionReady(principal.execution);
					const descriptor = principal.cell.getHeader().modelRequestJournal;
					expect(Object.keys(descriptor ?? {}).sort()).toEqual(["epochs", "journalId", "schemaVersion", "sessionId"]);
					expect(descriptor?.schemaVersion).toBe(1);
					const pair = registry(rootCell).slice(index * 2, index * 2 + 2);
					expect(pair.map(entry => entry.schemaVersion)).toEqual([2, 2]);
					expect(pair[0]?.record).toMatchObject({ event: "member-registered", sessionId: principal.cell.getSessionId(),
						parentSessionId: index === 0 ? null : principals[index - 1]!.cell.getSessionId(),
						ownerId: owners[index], journalEpoch: epochs[index] });
					expect(pair[1]?.record).toEqual({ event: "owner-registered", ownerId: owners[index],
						sessionId: principal.cell.getSessionId(), journalEpoch: epochs[index], writerOwnerId: fixture.writerId });
					const first = await appendJournalMetadata(principal.session, principal.execution, decision(principal.cell, rootCell));
					assertAck(first, principal.cell, 1);
					const source: ModelRequestSourceInput = { kind: "assistant", args: [{ role: "assistant",
						content: [{ type: "text", text: "local source" }], api: "openai-completions", provider: "openai", model: "fixture-model",
						stopReason: "stop", timestamp: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }] };
					const second = await appendJournalSource(principal.session, principal.execution, source,
						{ schemaVersion: 1, sourceKind: "assistant", resultId: null, provenance: { kind: "non-wire", reason: "local" } });
					assertAck(second, principal.cell, 2);
					expect(principal.cell.getEntry(second.sourceEntryId!)).toMatchObject({ type: "message", message: source.args[0] });
					const usage: ModelRequestSourceInput = { kind: "model_usage", args: [{ purpose: "title", api: source.args[0].api,
						provider: "openai", model: "fixture-model", stopReason: "stop", usage: source.args[0].usage },
						{ sessionId: principal.cell.getSessionId(), parentId: principal.cell.getLeafId() }] };
					const third = await appendJournalSource(principal.session, principal.execution, usage,
						{ schemaVersion: 1, sourceKind: "model_usage", resultId: null, provenance: { kind: "non-wire", reason: "local" } });
					assertAck(third, principal.cell, 3);
					const fourth = await appendJournalMetadata(principal.session, principal.execution, {
						schemaVersion: 1, event: "logical-result", requestId: randomUUID(), resultId: randomUUID(),
						sessionId: principal.cell.getSessionId(), journalOwnerId: epoch(principal.cell).journalOwnerId,
						usageAttemptIds: [], sourceDisposition: "none",
					});
					assertAck(fourth, principal.cell, 4);
					for (const entry of metadata(principal.cell)) {
						expect(entry.schemaVersion).toBe(1);
						expect(entry).toMatchObject({ journalOwnerId: owners[index], journalEpoch: epochs[index] });
					}
					validateModelRequestJournal([principal.cell.getHeader(), ...principal.cell.getEntries()]);
					const identity = attempt();
					const admission = await prepareJournalSend(principal.execution, identity);
					beginJournalSend(admission, principal.execution, identity);
					endJournalSendStart(admission);
				}
				await closeJournalSession(root.session);
				for (const principal of principals) {
					const closed = registry(rootCell).filter(entry => entry.record.sessionId === principal.cell.getSessionId() &&
						(entry.record.event === "member-closed" || entry.record.event === "owner-closed"));
					expect(closed).toHaveLength(2);
					expect(closed[0]?.record).toMatchObject({ event: "member-closed", journalEpoch: epoch(principal.cell).journalEpoch, throughSeq: 4 });
					expect(closed[1]?.record).toEqual({ event: "owner-closed", ownerId: epoch(principal.cell).journalOwnerId,
						sessionId: principal.cell.getSessionId(), journalEpoch: epoch(principal.cell).journalEpoch, throughSeq: 4, outcome: "closed" });
					const durable = fs.readFileSync(principal.cell.getSessionFile(), "utf8");
					for (const line of durable.trimEnd().split("\n")) {
						const value: unknown = JSON.parse(line);
						const record = object(value);
						if (record.type === "model_request_registry" && object(record.record).event === "owner-registered") continue;
						expect(line).not.toContain('"writerOwnerId"');
					}
				}
				validateModelRequestRegistry(rootCell.getHeader(), rootCell.getEntries());
				const durableRegistry = parseSessionContent(fs.readFileSync(rootCell.getSessionFile(), "utf8")).entries
					.filter(entry => entry.type === "model_request_registry");
				expect(durableRegistry).toEqual(registry(rootCell));
			});
		} finally { await fixture.close(); }
	});

	for (const agent of [
		{ ...mainAgent, kind: "sub" as const, depth: 99, parentId: "nonexistent" },
		{ ...mainAgent, name: "nonexistent", parentId: "display-agent" },
		{ ...mainAgent, id: "nonexistent", kind: "main" as const, depth: 0 },
	]) test(`DTO lineage cannot override genuine parent: ${JSON.stringify(agent)}`, async () => {
		const fixture = new R11JournalFixture();
		try {
			const rootCell = fixture.open();
			await fixture.withBinding(rootCell, async binding => {
				const root = await fixture.ready(binding, rootCell);
				const child = await fixture.ready(binding, fixture.open(), root);
				const deep = await fixture.ready(binding, fixture.open(), child, agent, rootCell);
				const member = registry(rootCell).find(entry => entry.record.event === "member-registered" && entry.record.sessionId === deep.cell.getSessionId());
				expect(member?.record).toMatchObject({ parentSessionId: child.cell.getSessionId() });
				const derived = deriveJournalExecution(deep.execution, { agent });
				assertJournalExecutionReady(derived);
				expect(derived.modelRequestScope?.sessionId).toBe(deep.cell.getSessionId());
				expect(derived.modelRequestScope?.rootSessionId).toBe(rootCell.getSessionId());
				const ack = await appendJournalMetadata(deep.session, derived, decision(deep.cell, rootCell));
				assertAck(ack, deep.cell, 1);
				await closeJournalSession(root.session);
			});
		} finally { await fixture.close(); }
	});

	for (const mode of ["missing", "fake", "copied", "wrong-root", "wrong-binding", "revoked", "pending"] as const) {
		test(`required child rejects ${mode} parent authority without durable registration`, async () => {
			const fixture = new R11JournalFixture();
			try {
				const rootCell = fixture.open();
				await fixture.withBinding(rootCell, async binding => {
					const root = await fixture.ready(binding, rootCell);
					const childCell = fixture.open();
					await childCell.ensureOnDisk();
					const childBytes = fs.readFileSync(childCell.getSessionFile(), "utf8");
					if (mode === "revoked") await closeJournalSession(root.session);
					const rootBytes = fs.readFileSync(rootCell.getSessionFile(), "utf8");
					if (mode === "wrong-binding") {
						await fixture.withBinding(rootCell, async otherBinding => {
							expect(otherBinding).not.toBe(binding);
							await rejected(() => createJournalExecution({ binding: otherBinding, parentExecution: root.execution, agent: mainAgent, purpose: "main" }));
						});
					} else {
						await rejected(() => {
							const parentExecution = mode === "missing" ? undefined : mode === "fake" ? {} as ModelRequestExecution :
								mode === "copied" ? { ...root.execution } : mode === "pending" ?
									createJournalExecution({ binding, agent: mainAgent, purpose: "main" }) : root.execution;
							const execution = createJournalExecution({ binding, agent: { ...mainAgent, kind: "sub", depth: 5, parentId: mainAgent.id },
								purpose: "main", ...(parentExecution === undefined ? {} : { parentExecution }) });
							return composeJournalSession({ cell: childCell, root: mode === "wrong-root" ? fixture.open() : rootCell, binding, execution });
						});
					}
					expect(fs.readFileSync(rootCell.getSessionFile(), "utf8")).toBe(rootBytes);
					expect(fs.readFileSync(childCell.getSessionFile(), "utf8")).toBe(childBytes);
					if (mode !== "revoked") await closeJournalSession(root.session);
				});
			} finally { await fixture.close(); }
		});
	}

	test("legacy v1 preserves all four historical record shapes on real read/serialize, but cannot compose or change bytes", async () => {
		const fixture = new R11JournalFixture();
		try {
			const original = fixture.open();
			await fixture.withBinding(original, async binding => {
				const ready = await fixture.ready(binding, original);
				await appendJournalMetadata(ready.session, ready.execution, decision(original, original));
				await closeJournalSession(ready.session);
			});
			await original.close();
			const historical = rewriteRecords(fs.readFileSync(original.getSessionFile(), "utf8"), record => {
				if (record.type === "session") object(record.modelRequestRegistry).schemaVersion = 1;
				if (record.type === "model_request_registry") {
					record.schemaVersion = 1;
					delete object(record.record).writerOwnerId;
				}
			});
			const filename = path.join(fixture.directory, "historical", "legacy.jsonl");
			fs.mkdirSync(path.dirname(filename), { mode: 0o700 });
			fs.writeFileSync(filename, historical, { mode: 0o600 });
			const legacy = fixture.open(filename);
			expect(registry(legacy).map(entry => entry.record.event)).toEqual(["member-registered", "owner-registered", "member-closed", "owner-closed"]);
			validateModelRequestRegistry(legacy.getHeader(), legacy.getEntries());
			const before = JSON.stringify(legacy.getEntries());
			await legacy.ensureOnDisk();
			expect(JSON.stringify(legacy.getEntries())).toBe(before);
			expect(fs.readFileSync(filename, "utf8")).toBe(historical);
			let checked = false;
			try {
				await fixture.withBinding(legacy, async binding => {
					const execution = createJournalExecution({ binding, agent: mainAgent, purpose: "main" });
					await rejected(() => composeJournalSession({ cell: legacy, root: legacy, binding, execution }));
					expect(execution.journalState).not.toBe("required-ready");
					expect(fs.readFileSync(filename, "utf8")).toBe(historical);
					checked = true;
				});
			} catch (error) {
				// The current verifier also rejects exit after failed composition. Do not
				// turn that lifetime behavior into an r11 acceptance requirement.
				if (!checked) throw error;
			}
			expect(checked).toBe(true);
			expect(fs.readFileSync(filename, "utf8")).toBe(historical);
		} finally { await fixture.close(); }
	});

	for (const mutation of ["mixed-schema", "missing-writer", "writer-tamper"] as const) {
		test(`${mutation} persisted history cannot authorize a prepared send and remains unchanged`, async () => {
			const fixture = new R11JournalFixture();
			try {
				const cell = fixture.open();
				let changed: string | undefined;
				let rejectionChecked = false;
				const operation = fixture.withBinding(cell, async binding => {
					const root = await fixture.ready(binding, cell);
					const identity = attempt();
					const admission = await prepareJournalSend(root.execution, identity);
					changed = rewriteRecords(fs.readFileSync(cell.getSessionFile(), "utf8"), record => {
						if (record.type !== "model_request_registry" || object(record.record).event !== "owner-registered") return;
						if (mutation === "mixed-schema") record.schemaVersion = 1;
						else if (mutation === "missing-writer") delete object(record.record).writerOwnerId;
						else object(record.record).writerOwnerId = `foreign-${randomUUID()}`;
					});
					fs.writeFileSync(cell.getSessionFile(), changed);
					expect(() => beginJournalSend(admission, root.execution, identity)).toThrow();
					assertReleasedNow(rootLock(fixture, cell));
					endJournalSendStart(admission);
					await rejected(() => prepareJournalSend(root.execution, attempt()));
					expect(fs.readFileSync(cell.getSessionFile(), "utf8")).toBe(changed);
					rejectionChecked = true;
				});
				// The real finalizer must also reject corrupt history; it must not
				// fabricate a logical-close acknowledgement or hide that failure.
				await expect(operation).rejects.toBeInstanceOf(AggregateError);
				expect(rejectionChecked).toBe(true);
				if (changed === undefined) throw new Error("Persisted corruption was not installed");
				expect(fs.readFileSync(cell.getSessionFile(), "utf8")).toBe(changed);
			} finally { await fixture.close(); }
		});
	}

	for (const closeRoot of [false, true]) test(`${closeRoot ? "root" : "child"} logical close joins pending real cell append, drain, and idempotent close`, async () => {
		const fixture = new R11JournalFixture();
		try {
			const rootCell = fixture.open();
			await fixture.withBinding(rootCell, async binding => {
				const root = await fixture.ready(binding, rootCell);
				const child = await fixture.ready(binding, fixture.open(), root);
				const deep = await fixture.ready(binding, fixture.open(), child, mainAgent, rootCell);
				const deepView = deriveJournalExecution(deep.execution, { purpose: "title", agent: mainAgent });
				const order: string[] = [];
				const pending = appendJournalMetadata(child.session, child.execution, decision(child.cell, rootCell))
					.then(ack => { order.push("append"); return ack; });
				expect(order).toEqual([]); // Actual #queue continuation has not run yet.
				const target = closeRoot ? root : child;
				const closing = closeJournalSession(target.session).then(() => { order.push("close"); });
				const repeated = closeJournalSession(target.session);
				const drain = child.cell.drain().then(() => { order.push("drain"); });
				const ack = await pending;
				await Promise.all([closing, repeated, drain]);
				expect(order[0]).toBe("append");
				assertAck(ack, child.cell, 1);
				for (const execution of [child.execution, deep.execution, deepView]) {
					expect(() => assertJournalExecutionReady(execution)).toThrow();
					await rejected(() => prepareJournalSend(execution, attempt()));
				}
				await rejected(() => appendJournalMetadata(deep.session, deepView, decision(deep.cell, rootCell)));
				const snapshot = fs.readFileSync(rootCell.getSessionFile(), "utf8");
				await closeJournalSession(target.session);
				expect(fs.readFileSync(rootCell.getSessionFile(), "utf8")).toBe(snapshot);
				const closes = registry(rootCell).filter(entry => entry.record.sessionId === child.cell.getSessionId() &&
					(entry.record.event === "member-closed" || entry.record.event === "owner-closed"));
				expect(closes).toHaveLength(2);
				for (const entry of closes) expect(entry.record).toMatchObject({ throughSeq: 1, outcome: "closed" });
				expect(tryAcquireRawModelRequestJournalFileLease(path.join(fixture.namespace, "owners", `${fixture.writerId}.lock`), "exclusive", rawOwner())).toBeUndefined();
				if (!closeRoot) {
					assertJournalExecutionReady(root.execution);
					const identity = attempt();
					const admission = await prepareJournalSend(root.execution, identity);
					beginJournalSend(admission, root.execution, identity);
					endJournalSendStart(admission);
					await appendJournalMetadata(root.session, root.execution, decision(rootCell, rootCell));
					await closeJournalSession(root.session);
				}
			});
		} finally { await fixture.close(); }
	});
	for (const cleanupDepth of [0, 1]) for (const pendingSource of [false, true]) {
		test(`concurrent sibling closes join ${cleanupDepth === 0 ? "root" : "parent"} cleanup with ${pendingSource ? "accepted source queues" : "a sealed root"}`, async () => {
			const fixture = new R11JournalFixture();
			try {
				const rootCell = fixture.open();
				await fixture.withBinding(rootCell, async binding => {
					const root = await fixture.ready(binding, rootCell);
					const parent = cleanupDepth === 0 ? root : await fixture.ready(binding, fixture.open(), root);
					const siblings = [
						await fixture.ready(binding, fixture.open(), parent, mainAgent, rootCell),
						await fixture.ready(binding, fixture.open(), parent, mainAgent, rootCell),
					];
					const source: ModelRequestSourceInput = { kind: "assistant", args: [{ role: "assistant",
						content: [{ type: "text", text: "accepted sibling source" }], api: "openai-completions",
						provider: "openai", model: "fixture-model", stopReason: "stop", timestamp: 1,
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }] };
					const pending = pendingSource ? siblings.map(sibling =>
						appendJournalSource(sibling.session, sibling.execution, source,
							{ schemaVersion: 1, sourceKind: "assistant", resultId: null, provenance: { kind: "non-wire", reason: "local" } })) : [];
					// No await between accepted work, independently owned sibling closes,
					// and ancestor cleanup. Empty queues also exercise real lock overlap.
					if (!pendingSource) rootCell.seal();
					const siblingCloses = siblings.map(sibling => closeJournalSession(sibling.session));
					const cleanup = closeJournalSession(parent.session);
					for (const [index, sibling] of siblings.entries()) {
						expect(closeJournalSession(sibling.session)).toBe(siblingCloses[index]);
						expect(() => assertJournalExecutionReady(sibling.execution)).toThrow();
					}
					const [acks] = await Promise.all([
						Promise.all(pending), Promise.all([...siblingCloses, cleanup]),
					]);
					for (const [index, sibling] of siblings.entries()) {
						if (pendingSource) {
							const ack = acks[index]!;
							assertAck(ack, sibling.cell, 1);
							expect(sibling.cell.getEntry(ack.sourceEntryId!)).toMatchObject({ type: "message", message: source.args[0] });
							const durable = parseSessionContent(fs.readFileSync(sibling.cell.getSessionFile(), "utf8")).entries;
							expect(durable.find(entry => entry.id === ack.sourceEntryId)).toEqual(sibling.cell.getEntry(ack.sourceEntryId!));
							expect(durable.find(entry => entry.id === ack.metadataEntryId)).toEqual(metadata(sibling.cell)[0]);
						}
						const closes = registry(rootCell).filter(entry => entry.record.sessionId === sibling.cell.getSessionId() &&
							(entry.record.event === "member-closed" || entry.record.event === "owner-closed"));
						expect(closes.map(entry => entry.record.event)).toEqual(["member-closed", "owner-closed"]);
						for (const entry of closes) expect(entry.record).toMatchObject({
							journalEpoch: epoch(sibling.cell).journalEpoch, throughSeq: pendingSource ? 1 : 0, outcome: "closed",
						});
						expect(closes[1]?.record).toMatchObject({ ownerId: epoch(sibling.cell).journalOwnerId });
					}
					if (cleanupDepth !== 0 && pendingSource) assertJournalExecutionReady(root.execution);
					rootCell.seal();
					await Promise.all([...fixture.cells].reverse().map(cell => cell.close()));
					const durableRegistry = parseSessionContent(fs.readFileSync(rootCell.getSessionFile(), "utf8")).entries
						.filter(entry => entry.type === "model_request_registry");
					expect(durableRegistry).toEqual(registry(rootCell));
					validateModelRequestRegistry(rootCell.getHeader(), durableRegistry);
					for (const cell of fixture.cells) {
						expect(durableRegistry.filter(entry => entry.record.sessionId === cell.getSessionId() &&
							(entry.record.event === "member-closed" || entry.record.event === "owner-closed"))).toHaveLength(2);
					}
					assertReleasedNow(rootLock(fixture, rootCell));
				});
			} finally { await fixture.close(); }
		});
	}

	for (const [depth, closeDepth] of [[2, 0], [4, 1]] as const) {
		test(`depth ${depth} accepted append drains before ancestor ${closeDepth} closes`, async () => {
			const fixture = new R11JournalFixture();
			try {
				const rootCell = fixture.open();
				await fixture.withBinding(rootCell, async binding => {
					const root = await fixture.ready(binding, rootCell);
					const chain: ReadyPrincipal[] = [root];
					for (let level = 1; level <= depth; level++) {
						chain.push(await fixture.ready(binding, fixture.open(), chain[level - 1],
							{ ...mainAgent, kind: "sub", depth: level }, rootCell));
					}
					const deep = chain[depth]!, ancestor = chain[closeDepth]!;
					const appended = appendJournalMetadata(deep.session, deep.execution, decision(deep.cell, rootCell));
					const closing = closeJournalSession(ancestor.session);
					const joined = Promise.all([appended, closing]);
					expect(closeJournalSession(deep.session)).toBe(closing);
					for (const member of chain.slice(closeDepth)) {
						expect(() => assertJournalExecutionReady(member.execution)).toThrow();
					}
					const [ack] = await joined;
					assertAck(ack, deep.cell, 1);
					expect(metadata(deep.cell)).toHaveLength(1);
					const closes = registry(rootCell).filter(entry =>
						entry.record.sessionId === deep.cell.getSessionId() &&
						(entry.record.event === "member-closed" || entry.record.event === "owner-closed"));
					expect(closes).toHaveLength(2);
					for (const entry of closes) expect(entry.record).toMatchObject({ throughSeq: 1, outcome: "closed" });
					if (closeDepth !== 0) {
						assertJournalExecutionReady(root.execution);
						await appendJournalMetadata(root.session, root.execution, decision(rootCell, rootCell));
						await closeJournalSession(root.session);
					}
					await Promise.all([...fixture.cells].reverse().map(cell => cell.close()));
				});
			} finally { await fixture.close(); }
		});
	}
});

mac("r11 actual File send admission closure", () => {
	test("prepare rejects fake/copied executions, invalid attempts, and genuine pending/closed families", async () => {
		const fixture = new R11JournalFixture();
		try {
			const cell = fixture.open();
			await fixture.withBinding(cell, async binding => {
				const root = await fixture.ready(binding, cell);
				await rejected(() => prepareJournalSend({} as ModelRequestExecution, attempt()));
				await rejected(() => prepareJournalSend({ ...root.execution }, attempt()));
				const pending = createJournalExecution({ binding, agent: mainAgent, purpose: "main" });
				await rejected(() => prepareJournalSend(pending, attempt()));
				await rejected(() => prepareJournalSend(root.execution, {} as ClosedCoreAttemptIdentity));
				await rejected(() => prepareJournalSend(root.execution, { attemptId: "" }));
				const identity = attempt();
				const admission = await prepareJournalSend(root.execution, identity);
				endJournalSendStart(admission);
				assertReleasedNow(rootLock(fixture, cell));
				await closeJournalSession(root.session);
				await rejected(() => prepareJournalSend(root.execution, attempt()));
			});
		} finally { await fixture.close(); }
	});

	test("prepare/begin/end succeeds and releases actual root synchronously before any microtask, retaining writer lease", async () => {
		const fixture = new R11JournalFixture();
		try {
			const cell = fixture.open();
			await fixture.withBinding(cell, async binding => {
				const root = await fixture.ready(binding, cell);
				const identity = attempt();
				const admission = await prepareJournalSend(root.execution, identity);
				const filename = rootLock(fixture, cell);
				expect(tryAcquireRawModelRequestJournalFileLease(filename, "exclusive", rawOwner())).toBeUndefined();
				beginJournalSend(admission, root.execution, identity);
				let microtask = false;
				queueMicrotask(() => { microtask = true; });
				endJournalSendStart(admission);
				expect(microtask).toBe(false);
				assertReleasedNow(filename);
				endJournalSendStart(admission);
				expect(tryAcquireRawModelRequestJournalFileLease(path.join(fixture.namespace, "owners", `${fixture.writerId}.lock`), "exclusive", rawOwner())).toBeUndefined();
				await rejected(() => prepareJournalSend(root.execution, identity));
				expect(() => beginJournalSend(admission, root.execution, identity)).toThrow();
				const nextIdentity = attempt();
				const next = await prepareJournalSend(root.execution, nextIdentity);
				beginJournalSend(next, root.execution, nextIdentity);
				endJournalSendStart(next);
				await closeJournalSession(root.session);
			});
		} finally { await fixture.close(); }
	});

	for (const mode of ["attempt-mismatch", "attempt-copy", "attempt-mutated", "execution-copy", "execution-fake", "execution-derived", "execution-other-family", "admission-copy", "admission-fake", "replay", "ended", "revoked"] as const) {
		test(`prepare/begin/end rejects ${mode} without leaking the actual retained root`, async () => {
			const fixture = new R11JournalFixture();
			try {
				const cell = fixture.open();
				await fixture.withBinding(cell, async binding => {
					const root = await fixture.ready(binding, cell);
					const child: ReadyPrincipal | undefined = mode === "execution-other-family" ? await fixture.ready(binding, fixture.open(), root) : undefined;
					const identity = { attemptId: randomUUID() };
					const admission = await prepareJournalSend(root.execution, identity);
					const filename = rootLock(fixture, cell);
					const suppliedAttempt = mode === "attempt-mismatch" ? attempt() : mode === "attempt-copy" ? { ...identity } : identity;
					const suppliedExecution = mode === "execution-copy" ? { ...root.execution } : mode === "execution-fake" ? {} as ModelRequestExecution :
						mode === "execution-derived" ? deriveJournalExecution(root.execution, { purpose: "title" }) : child?.execution ?? root.execution;
					const suppliedAdmission = mode === "admission-copy" ? { ...admission } : mode === "admission-fake" ? {} as OpaqueSendAdmission : admission;
					if (mode === "attempt-mutated") identity.attemptId = randomUUID();
					if (mode === "replay") beginJournalSend(admission, root.execution, identity);
					if (mode === "ended") endJournalSendStart(admission);
					if (mode === "revoked") cell.seal();
					try {
						expect(() => beginJournalSend(suppliedAdmission, suppliedExecution, suppliedAttempt)).toThrow();
						if (mode === "admission-copy" || mode === "admission-fake") {
							// A fake object must not be allowed to release somebody else's genuine admission.
							expect(tryAcquireRawModelRequestJournalFileLease(filename, "exclusive", rawOwner())).toBeUndefined();
							expect(() => endJournalSendStart(suppliedAdmission)).toThrow();
							endJournalSendStart(admission);
						}
						assertReleasedNow(filename);
						endJournalSendStart(admission);
						await rejected(() => prepareJournalSend(root.execution, identity));
						if (mode === "revoked") await rejected(() => prepareJournalSend(root.execution, attempt()));
					} finally { endJournalSendStart(admission); }
					if (mode !== "revoked") await closeJournalSession(root.session);
				});
			} finally { await fixture.close(); }
		});
	}
});
