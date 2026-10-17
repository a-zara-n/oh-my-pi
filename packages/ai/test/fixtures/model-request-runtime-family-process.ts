import { randomUUID } from "node:crypto";
import type { ModelRequestAgent } from "@oh-my-pi/pi-utils/model-request-data";
import {
	assertJournalExecutionIdentity,
	assertJournalExecutionReady,
	closeJournalSession,
	composeJournalSession,
	type FileJournalCell,
	type JournalSession,
	type ModelRequestExecution,
} from "@oh-my-pi/pi-utils/model-request-journal-composition";
import type { ModelRequestRegistryEntry } from "@oh-my-pi/pi-utils/session-entries";
import { R11JournalFixture } from "../../../utils/test/fixtures/model-request-journal-r11";
import {
	getModelRequestRuntime,
	type ModelRequestExecutionInit,
	type ModelRequestRootSource,
} from "../../src/model-request-runtime";

const runtime = getModelRequestRuntime();
const mode = process.argv[2];
const agent: ModelRequestAgent = { id: "same-display-agent", name: "main", kind: "main", depth: 0 };

function rejected(use: () => unknown): boolean {
	try { use(); return false; }
	catch { return true; }
}

function untracked(): object {
	const root = runtime.createSessionExecution({ sessionId: () => "ordinary-root", root: { kind: "self" }, agent, purpose: "main" });
	const init = (sessionId: string, parentExecution?: ModelRequestExecution): ModelRequestExecutionInit => ({
		sessionId: () => sessionId,
		root: { kind: "inherited", rootSessionId: "ordinary-root", ...(parentExecution === undefined ? {} : { parentExecution }) },
		agent, purpose: "subagent",
	});
	const child = runtime.runWith(root, () => runtime.createSessionExecution(init("ordinary-child", root)));
	const derived = runtime.deriveExecution(child, { purpose: "advisor" });
	const deep = runtime.runWith(derived, () => runtime.createSessionExecution(init("ordinary-deep", child)));
	const revived = runtime.createSessionExecution(init("ordinary-revived", root));
	const legacy = runtime.createSessionExecution(init("ordinary-legacy"));
	return {
		mode,
		states: [root, child, derived, deep, revived, legacy].map(execution => execution.journalState),
		scopes: [root, child, derived, deep, revived, legacy].map(execution => runtime.scopeOf(execution)),
		derivedDifferentObject: derived !== child,
	};
}

async function native(): Promise<object> {
	const fixture = new R11JournalFixture();
	try {
		const rootCell = fixture.open();
		return await fixture.withBinding(rootCell, async binding => {
			const sessions: JournalSession[] = [];
			let primaryFailure: { readonly error: unknown } | undefined;
			try {
				const root = runtime.createSessionExecution({
					sessionId: () => rootCell.getSessionId(), root: { kind: "self", modelRequestJournalLeaseBinding: binding }, agent, purpose: "main",
				});
				assertJournalExecutionIdentity(root);
				const pendingSingleArgument = root.journalState === "required-pending";
				sessions.push(await composeJournalSession({ cell: rootCell, root: rootCell, binding, execution: root }));
				assertJournalExecutionReady(root);
				const derivedRoot = runtime.deriveExecution(root, { purpose: "advisor" });
				assertJournalExecutionIdentity(derivedRoot, root);
				assertJournalExecutionReady(derivedRoot);
				const init = (cell: FileJournalCell, parentExecution: ModelRequestExecution): ModelRequestExecutionInit => ({
					sessionId: () => cell.getSessionId(),
					root: { kind: "inherited", rootSessionId: rootCell.getSessionId(), modelRequestJournalLeaseBinding: binding, parentExecution },
					agent, purpose: "main",
				});
				const childCell = fixture.open();
				let parentGetterCalls = 0;
				const childRoot: ModelRequestRootSource = {
					kind: "inherited", rootSessionId: rootCell.getSessionId(), modelRequestJournalLeaseBinding: binding,
					get parentExecution() {
						parentGetterCalls++;
						if (parentGetterCalls !== 1) throw new Error("runtime reacquired the explicit parent");
						return derivedRoot;
					},
				};
				const child = runtime.runWith(root, () => runtime.createSessionExecution({ ...init(childCell, derivedRoot), root: childRoot }));
				const childSession = await composeJournalSession({ cell: childCell, root: rootCell, binding, execution: child });
				sessions.push(childSession);
				assertJournalExecutionReady(child);
				const rootScope = runtime.scopeOf(root);
				const childScope = runtime.scopeOf(child);
				const sameRoot = rootScope.rootSessionId === childScope.rootSessionId;
				const sameAgentDto = JSON.stringify(rootScope.agent) === JSON.stringify(childScope.agent);
				const sameBinding = root.modelRequestJournalLeaseBinding === child.modelRequestJournalLeaseBinding;
				const wrongFamilyCell = fixture.open();
				const wrongFamilyRejected = rejected(() => runtime.runWith(root, () => runtime.createSessionExecution(init(wrongFamilyCell, child))));
				const pureDifferentFamilyRejected = rejected(() => assertJournalExecutionIdentity(child, root));
				const fakeFirstRejected = rejected(() => Reflect.apply(assertJournalExecutionIdentity, undefined, [{}, root]));
				const fakeSecondRejected = rejected(() => Reflect.apply(assertJournalExecutionIdentity, undefined, [root, {}]));
				const missingParentRejected = rejected(() => runtime.runWith(root, () => runtime.createSessionExecution({
					...init(wrongFamilyCell, root), root: { kind: "inherited", rootSessionId: rootCell.getSessionId(), modelRequestJournalLeaseBinding: binding },
				})));
				const wrongRootRejected = rejected(() => runtime.runWith(root, () => runtime.createSessionExecution({
					...init(wrongFamilyCell, root), root: { kind: "inherited", rootSessionId: randomUUID(), modelRequestJournalLeaseBinding: binding, parentExecution: root },
				})));
				let wrongBindingRejected = false;
				await fixture.withBinding(rootCell, async otherBinding => {
					wrongBindingRejected = rejected(() => runtime.runWith(root, () => runtime.createSessionExecution({
						...init(wrongFamilyCell, root), root: { kind: "inherited", rootSessionId: rootCell.getSessionId(), modelRequestJournalLeaseBinding: otherBinding, parentExecution: root },
					})));
				});
				const deepCell = fixture.open();
				const derivedChild = runtime.deriveExecution(child, { purpose: "advisor" });
				const deep = runtime.runWith(derivedChild, () => runtime.createSessionExecution(init(deepCell, child)));
				const deepSession = await composeJournalSession({ cell: deepCell, root: rootCell, binding, execution: deep });
				sessions.push(deepSession);
				assertJournalExecutionReady(deep);
				const handoverCell = fixture.open();
				const handover = runtime.createSessionExecution(init(handoverCell, derivedRoot));
				sessions.push(await composeJournalSession({ cell: handoverCell, root: rootCell, binding, execution: handover }));
				assertJournalExecutionReady(handover);
				const registry = rootCell.getEntries().filter((entry): entry is ModelRequestRegistryEntry => entry.type === "model_request_registry");
				const member = registry.find(entry => entry.record.event === "member-registered" && entry.record.sessionId === deepCell.getSessionId());
				const deepParent = member?.record.event === "member-registered" ? member.record.parentSessionId : undefined;
				const readyStates = [root, derivedRoot, child, derivedChild, deep, handover].map(execution => execution.journalState);
				await closeJournalSession(deepSession);
				await closeJournalSession(childSession);
				const revokedState = child.journalState;
				assertJournalExecutionIdentity(child, derivedChild);
				const revokedIdentityPure = child.journalState === revokedState;
				const revokedReadyRejected = rejected(() => assertJournalExecutionReady(child));
				const revokedParentRejected = rejected(() => runtime.runWith(derivedChild, () => runtime.createSessionExecution(init(wrongFamilyCell, child))));
				return {
					mode, pendingSingleArgument, parentGetterCalls, readyStates,
					derivedDifferentObject: derivedRoot !== root,
					sameRoot, sameAgentDto, sameBinding, wrongFamilyRejected, pureDifferentFamilyRejected,
					fakeFirstRejected, fakeSecondRejected, missingParentRejected, wrongRootRejected, wrongBindingRejected,
					deepParentMatches: deepParent === childCell.getSessionId(),
					handoverWithoutAlsReady: handover.journalState === "required-ready",
					revokedIdentityPure, revokedReadyRejected, revokedParentRejected,
				};
			} catch (error) {
				primaryFailure = { error };
				throw error;
			} finally {
				const failures: unknown[] = [];
				for (const session of sessions.toReversed()) {
					try { await closeJournalSession(session); }
					catch (error) { failures.push(error); }
				}
				if (failures.length > 0) {
					throw new AggregateError([...(primaryFailure === undefined ? [] : [primaryFailure.error]), ...failures], "runtime family fixture close failed");
				}
			}
		});
	} finally { await fixture.close(); }
}

if (mode !== "native" && mode !== "untracked") throw new Error("unknown runtime family probe mode");
console.log(JSON.stringify(mode === "native" ? await native() : untracked()));
