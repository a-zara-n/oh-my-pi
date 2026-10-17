/**
 * Managed-execution boundary refusals, one scenario per fresh child process.
 *
 * Creating an execution with a binding flips the process-wide required latch in
 * the real journal composition; these refusals therefore cannot share a file
 * with ordinary untracked tests (see model-request-journal-composition).
 * Assertions observe the boundary (refusal before any I/O, gate not consulted)
 * without pinning the exact refusal wording.
 */
import { isModelRequestDenied } from "@oh-my-pi/pi-ai/error";
import { createModelRequestSessionExecution } from "@oh-my-pi/pi-ai/model-request-execution";
import {
	getModelRequestRuntime,
	type ModelRequestAuthorizationInput,
} from "../../src/model-request-runtime";
import { registerModelRequestGate, type ModelRequestDecision } from "@oh-my-pi/pi-ai/model-request-gate";
import { gatedSend } from "../../src/utils/model-request-fetch";
import type { ModelRequestJournalLeaseBinding } from "@oh-my-pi/pi-utils/model-request-journal-authority";

const scenario = process.argv[2];
const INPUT: ModelRequestAuthorizationInput = {
	requestId: "request-1",
	reason: "first",
	kind: "chat",
	model: { provider: "fixture", id: "fixture-1", api: "fixture-api" },
	wire: undefined,
};
/** A gate that records what it was asked and answers pass. */
function recordingPassGate(): { attempts: number } {
	const state = { attempts: 0 };
	registerModelRequestGate("managed-boundary-fixture", {
		async authorize(): Promise<ModelRequestDecision> {
			state.attempts++;
			return { type: "pass" };
		},
	});
	return state;
}

function managedExecution() {
	// Deliberately invalid boundary input: refusal only, never issued authority.
	const invalidBinding = {} as ModelRequestJournalLeaseBinding;
	return createModelRequestSessionExecution({
		sessionId: () => "managed-boundary-session",
		root: { kind: "self", modelRequestJournalLeaseBinding: invalidBinding },
		agent: { kind: "main", id: "Main", name: "main", depth: 0 },
		purpose: "main",
	});
}

async function sendThroughWire(): Promise<void> {
	await gatedSend({
		model: INPUT.model,
		kind: "chat",
		input: "http://127.0.0.1:9/never-reached",
		init: undefined,
		send: async () => new Response("must not be sent"),
	});
}

async function refusal(promise: Promise<unknown>): Promise<{ refused: boolean; denied: boolean }> {
	try {
		await promise;
		return { refused: false, denied: false };
	} catch (error) {
		return { refused: true, denied: isModelRequestDenied(error) };
	}
}

if (!scenarios.some(value => value === scenario)) throw new Error(`unknown managed boundary scenario: ${scenario}`);

const runtime = getModelRequestRuntime();
let result: Record<string, unknown>;
switch (scenario) {
	case "authorize-refused": {
		const execution = managedExecution();
		result = await refusal(runWithModelRequestExecution(execution, () => runtime.authorize(INPUT)));
		break;
	}
	case "derived-send-refused": {
		const execution = managedExecution();
		const derived = runtime.deriveExecution(execution, { purpose: "advisor" });
		if (derived.modelRequestJournalLeaseBinding !== execution.modelRequestJournalLeaseBinding) {
			throw new Error("derived execution lost its binding projection");
		}
		const first = await refusal(runWithModelRequestExecution(execution, sendThroughWire));
		const second = await refusal(runWithModelRequestExecution(derived, sendThroughWire));
		result = { first, second };
		break;
	}
	case "gate-pass-refused": {
		const gate = recordingPassGate();
		const execution = managedExecution();
		const outcome = await refusal(runWithModelRequestExecution(execution, () => runtime.authorize(INPUT)));
		result = { outcome, gateAttempts: gate.attempts };
		break;
	}
}
