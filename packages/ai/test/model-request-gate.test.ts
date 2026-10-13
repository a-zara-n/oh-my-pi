import { afterEach, describe, expect, test, vi } from "bun:test";
import { EventEmitter } from "node:events";
import * as AIError from "@oh-my-pi/pi-ai/error";
import {
	type ModelRequestAttempt,
	ModelRequestDeniedError,
	type ModelRequestDecision,
	type ModelRequestGate,
	type ModelRequestLease,
	type ModelRequestOutcome,
} from "@oh-my-pi/pi-ai/model-request-gate";
import {
	type ModelRequestAuthorizationInput,
	type ModelRequestExecution,
	type ModelRequestExecutionInit,
	ModelRequestRuntime,
} from "@oh-my-pi/pi-ai/model-request-runtime";

afterEach(() => {
	vi.useRealTimers();
});

function newRuntime(): ModelRequestRuntime {
	let next = 0;
	return new ModelRequestRuntime({ newAttemptId: () => `attempt-${++next}` });
}

const INPUT: ModelRequestAuthorizationInput = {
	requestId: "req-1",
	reason: "first",
	kind: "chat",
	model: { provider: "fake", id: "fake-1", api: "fake-api" },
	wire: undefined,
};

function sessionInit(overrides: Partial<ModelRequestExecutionInit> = {}): ModelRequestExecutionInit {
	return {
		sessionId: () => "session-A",
		root: { kind: "self" },
		agent: { id: "Main", kind: "main", name: "main", depth: 0 },
		purpose: "main",
		...overrides,
	};
}

/** The error a promise rejects with; fails the test if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the promise to reject");
}

/** The gate denial a promise rejects with; fails the test if it rejects with anything else. */
async function denial(promise: Promise<unknown>): Promise<ModelRequestDeniedError> {
	const error = await rejection(promise);
	if (!(error instanceof ModelRequestDeniedError)) throw new Error(`expected a gate denial, got ${String(error)}`);
	return error;
}

/** A gate that records what it was asked and answers with `decide`. */
function recordingGate(decide: (attempt: ModelRequestAttempt) => Promise<ModelRequestDecision> | ModelRequestDecision) {
	const attempts: ModelRequestAttempt[] = [];
	const gate: ModelRequestGate = {
		async authorize(attempt) {
			attempts.push(attempt);
			return decide(attempt);
		},
	};
	return { gate, attempts };
}

const PASS = (): ModelRequestDecision => ({ type: "pass" });

/** A gate whose answer does not honor the ModelRequestGate contract; the core must not trust it. */
function nonConformingGate(answer: () => Promise<unknown>): ModelRequestGate {
	// Intentional: models an out-of-contract gate (the types cannot express a lying implementation).
	const gate: unknown = { authorize: answer };
	return gate as ModelRequestGate;
}

/** A lookalike of an execution handle that the core did not mint. */
function forgedExecution(): ModelRequestExecution {
	// Intentional: models a caller fabricating a context object (the handle's type is opaque).
	const forged: unknown = { sessionId: () => "x", root: { kind: "self" }, purpose: "main" };
	return forged as ModelRequestExecution;
}

interface LeaseRecorder {
	readonly lease: ModelRequestLease;
	readonly calls: string[];
	readonly settled: ModelRequestOutcome[];
	/** Resolves when `settle` is first called. */
	readonly firstSettle: Promise<void>;
}

function leaseRecorder(): LeaseRecorder {
	const calls: string[] = [];
	const settled: ModelRequestOutcome[] = [];
	const first = Promise.withResolvers<void>();
	const lease: ModelRequestLease = {
		beginSend: () => void calls.push("beginSend"),
		observeResponse: () => void calls.push("observeResponse"),
		observeChunk: () => void calls.push("observeChunk"),
		settle: async outcome => {
			calls.push("settle");
			settled.push(outcome);
			first.resolve();
		},
	};
	return { lease, calls, settled, firstSettle: first.promise };
}

/** What a fake transport does once the core says go: count a request that reached the wire. */
async function sendThroughFakeTransport(runtime: ModelRequestRuntime, wireRequests: string[]): Promise<void> {
	await runtime.authorize(INPUT);
	wireRequests.push("sent");
}

describe("gate registration latch", () => {
	test("a different gate, owner or options cannot replace the registered one, so a gate cannot be dropped midway", () => {
		const runtime = newRuntime();
		const first = recordingGate(PASS).gate;
		runtime.registerGate("owner-a", first, undefined);

		runtime.registerGate("owner-a", first, undefined); // same registration again: idempotent
		expect(() => runtime.registerGate("owner-a", recordingGate(PASS).gate, undefined)).toThrow(/already registered/);
		expect(() => runtime.registerGate("owner-b", first, undefined)).toThrow(/already registered/);
		expect(() => runtime.registerGate("owner-a", first, { authorizeTimeoutMs: 50 })).toThrow(/already registered/);
	});

	test("accepts the largest timeout a platform timer honors", () => {
		expect(() => newRuntime().registerGate("owner", recordingGate(PASS).gate, { authorizeTimeoutMs: 2_147_483_647 })).not.toThrow();
	});

	test("rejects a timeout that is not a positive integer a platform timer can honor, instead of clamping or inventing a default", () => {
		const gate = recordingGate(PASS).gate;
		for (const authorizeTimeoutMs of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, Number.MAX_SAFE_INTEGER]) {
			expect(() => newRuntime().registerGate("owner", gate, { authorizeTimeoutMs })).toThrow(RangeError);
		}
	});
});

describe("authorize: gate verdicts reach the caller before any I/O", () => {
	test("a denial throws a non-retryable error with the gate's code, and the transport never sees the request", async () => {
		const runtime = newRuntime();
		runtime.registerGate(
			"owner",
			recordingGate(() => ({ type: "deny", code: "over-limit", message: "429 usage limit reached, rotate credentials" })).gate,
			undefined,
		);
		const wire: string[] = [];

		const failure = await denial(sendThroughFakeTransport(runtime, wire));

		expect(failure.code).toBe("over-limit");
		expect(failure.retryable).toBe(false);
		expect(wire).toEqual([]);
		// Whatever the text says, the shared classifier must treat it as a terminal denial, not a rotatable 429.
		expect(AIError.is(AIError.classify(failure), AIError.Flag.ModelRequestDenied)).toBe(true);
		expect(AIError.is(AIError.classify(failure), AIError.Flag.UsageLimit)).toBe(false);
		expect(AIError.isAuthRetryableError(failure)).toBe(false);
	});

	test.each([
		["throws", () => Promise.reject(new Error("db locked"))],
		["resolves undefined", () => Promise.resolve(undefined)],
		["resolves an unknown decision type", () => Promise.resolve({ type: "maybe" })],
		["allows without a usable lease", () => Promise.resolve({ type: "allow", lease: { beginSend() {} } })],
		["denies without a code", () => Promise.resolve({ type: "deny", message: "no" })],
	])("a gate that %s is a gate-error and nothing is sent", async (_name, answer) => {
		const runtime = newRuntime();
		runtime.registerGate("owner", nonConformingGate(answer), undefined);
		const wire: string[] = [];

		const failure = await denial(sendThroughFakeTransport(runtime, wire));

		expect(failure.code).toBe("gate-error");
		expect(wire).toEqual([]);
	});

	test("a gate that never answers is a gate-error once the registered timeout passes, with nothing sent", async () => {
		vi.useFakeTimers();
		const runtime = newRuntime();
		runtime.registerGate("owner", { authorize: () => new Promise<ModelRequestDecision>(() => {}) }, { authorizeTimeoutMs: 20 });
		const wire: string[] = [];

		const outcome = denial(sendThroughFakeTransport(runtime, wire));
		vi.advanceTimersByTime(20);
		const failure = await outcome;

		expect(failure.code).toBe("gate-error");
		expect(wire).toEqual([]);
	});

	test("a reservation granted after the caller stopped waiting is released as not-sent exactly once", async () => {
		vi.useFakeTimers();
		const runtime = newRuntime();
		const { lease, settled, firstSettle } = leaseRecorder();
		const late = Promise.withResolvers<ModelRequestDecision>();
		runtime.registerGate("owner", { authorize: () => late.promise }, { authorizeTimeoutMs: 20 });

		const outcome = denial(runtime.authorize(INPUT));
		vi.advanceTimersByTime(20);
		expect((await outcome).code).toBe("gate-error");

		late.resolve({ type: "allow", lease });
		await firstSettle;
		expect(settled).toEqual([{ type: "not-sent", aborted: false }]);
	});

	test("an already-aborted signal stops before the gate is even asked", async () => {
		const runtime = newRuntime();
		const { gate, attempts } = recordingGate(PASS);
		runtime.registerGate("owner", gate, undefined);
		const controller = new AbortController();
		const reason = new Error("caller gave up");
		controller.abort(reason);

		const failure = await rejection(runtime.authorize({ ...INPUT, signal: controller.signal }));

		expect(failure).toBe(reason);
		expect(attempts).toEqual([]);
	});

	test("aborting while the gate decides rejects with the abort reason and releases a lease granted meanwhile", async () => {
		const runtime = newRuntime();
		const { lease, settled, firstSettle } = leaseRecorder();
		const decision = Promise.withResolvers<ModelRequestDecision>();
		runtime.registerGate("owner", { authorize: () => decision.promise }, undefined);
		const controller = new AbortController();

		const outcome = rejection(runtime.authorize({ ...INPUT, signal: controller.signal }));
		const reason = new Error("user interrupt");
		controller.abort(reason);
		expect(await outcome).toBe(reason);

		decision.resolve({ type: "allow", lease });
		await firstSettle;
		expect(settled).toEqual([{ type: "not-sent", aborted: true }]);
	});

	test("with no gate registered the request is handed back untouched: no lease", async () => {
		const permit = await newRuntime().authorize(INPUT);
		expect(permit.lease).toBeUndefined();
	});
});

describe("lease protocol is enforced by the core, not left to each call site", () => {
	test("settle runs once however often it is called, and ordering violations throw", async () => {
		const runtime = newRuntime();
		const { lease, calls, settled } = leaseRecorder();
		runtime.registerGate("owner", recordingGate(() => ({ type: "allow", lease })).gate, undefined);

		const permit = await runtime.authorize(INPUT);
		const guarded = permit.lease;
		if (guarded === undefined) throw new Error("expected a lease");

		expect(() => guarded.observeChunk(new Uint8Array(1))).toThrow(/before beginSend/);
		guarded.beginSend();
		expect(() => guarded.beginSend()).toThrow(/twice/);
		guarded.observeResponse({ status: 200, headers: {} });
		await Promise.all([
			guarded.settle({ type: "response-ended", status: 200 }),
			guarded.settle({ type: "not-sent", aborted: true }),
		]);
		expect(() => guarded.observeChunk(new Uint8Array(1))).toThrow(/after settle/);

		expect(calls).toEqual(["beginSend", "observeResponse", "settle"]);
		expect(settled).toEqual([{ type: "response-ended", status: 200 }]);
	});
});

describe("origin and scope are decided by the core from its own context", () => {
	test("inside a session execution the gate gets origin 'session'; a self root follows the session id per request", async () => {
		const runtime = newRuntime();
		const { gate, attempts } = recordingGate(PASS);
		runtime.registerGate("owner", gate, undefined);
		let sessionId = "session-A";
		const execution = runtime.createSessionExecution(sessionInit({ sessionId: () => sessionId }));

		await runtime.runWith(execution, () => runtime.authorize(INPUT));
		sessionId = "session-B"; // /new
		await runtime.runWith(execution, () => runtime.authorize(INPUT));

		expect(attempts.map(a => [a.origin, a.scope?.sessionId, a.scope?.rootSessionId])).toEqual([
			["session", "session-A", "session-A"],
			["session", "session-B", "session-B"],
		]);
	});

	test("a child keeps the root its spawner handed over, and a child with no hand-over reaches the gate root-less", async () => {
		const runtime = newRuntime();
		const { gate, attempts } = recordingGate(PASS);
		runtime.registerGate("owner", gate, undefined);
		const child = (rootSessionId: string | undefined) =>
			runtime.createSessionExecution(
				sessionInit({
					sessionId: () => "session-child",
					root: { kind: "inherited", rootSessionId },
					agent: { id: "0-Explore", kind: "sub", name: "explore", depth: 1, parentId: "Main" },
					purpose: "subagent",
				}),
			);

		await runtime.runWith(child("session-root"), () => runtime.authorize(INPUT));
		await runtime.runWith(child(undefined), () => runtime.authorize(INPUT));

		expect(attempts.map(a => [a.scope?.sessionId, a.scope?.rootSessionId, a.scope?.agent.depth])).toEqual([
			["session-child", "session-root", 1],
			["session-child", undefined, 1],
		]);
	});

	test("a derived execution changes purpose and agent but never the root the request is billed to", async () => {
		const runtime = newRuntime();
		const { gate, attempts } = recordingGate(PASS);
		runtime.registerGate("owner", gate, undefined);
		const base = runtime.createSessionExecution(sessionInit());
		const advisor = runtime.deriveExecution(base, {
			purpose: "advisor",
			agent: { id: "advisor", kind: "sub", name: "advisor", depth: 0, parentId: "Main" },
		});

		await runtime.runWith(advisor, () => runtime.authorize(INPUT));

		const scope = attempts[0]?.scope;
		expect([scope?.purpose, scope?.agent.id, scope?.sessionId, scope?.rootSessionId]).toEqual([
			"advisor",
			"advisor",
			"session-A",
			"session-A",
		]);
	});

	test("a fabricated execution, or one minted by another runtime, is refused rather than trusted", () => {
		const runtime = newRuntime();
		const foreign = newRuntime().createSessionExecution(sessionInit());

		expect(() => runtime.runWith(forgedExecution(), () => 1)).toThrow(/not a core-minted/);
		expect(() => runtime.runWith(foreign, () => 1)).toThrow(/not a core-minted/);
	});

	test("outside any execution the gate sees 'unclassified'; once marked standalone it sees 'standalone' and the process can never create a session", async () => {
		const runtime = newRuntime();
		const { gate, attempts } = recordingGate(PASS);
		runtime.registerGate("owner", gate, undefined);

		await runtime.authorize(INPUT);
		runtime.markStandalone();
		await runtime.authorize(INPUT);

		expect(attempts.map(a => [a.origin, a.scope])).toEqual([
			["unclassified", undefined],
			["standalone", undefined],
		]);
		expect(() => runtime.createSessionExecution(sessionInit())).toThrow(/standalone cannot create a session/);
	});

	test("a process that already created a session cannot be marked standalone afterwards", () => {
		const runtime = newRuntime();
		runtime.createSessionExecution(sessionInit());
		expect(() => runtime.markStandalone()).toThrow(/after a session was created/);
	});

	test("a gate cannot rewrite the identity it was shown", async () => {
		const runtime = newRuntime();
		let rewritten: boolean | undefined;
		let rootAfterRewrite: string | undefined;
		runtime.registerGate(
			"owner",
			{
				async authorize(attempt) {
					if (attempt.scope !== undefined) {
						rewritten = Reflect.set(attempt.scope, "rootSessionId", "stolen");
						rootAfterRewrite = attempt.scope.rootSessionId;
					}
					return PASS();
				},
			},
			undefined,
		);
		const execution = runtime.createSessionExecution(sessionInit());

		await runtime.runWith(execution, () => runtime.authorize(INPUT));

		expect([rewritten, rootAfterRewrite]).toEqual([false, "session-A"]);
	});
});

describe("context propagation behaves as the inventory assumes", () => {
	test("the context survives awaits; an EventEmitter listener sees the EMITTER's context and bind() restores the registrar's", async () => {
		const runtime = newRuntime();
		const outer = runtime.createSessionExecution(sessionInit());
		const seen: Record<string, boolean> = {};
		const emitter = new EventEmitter();

		await runtime.runWith(outer, async () => {
			await Promise.resolve();
			await Bun.sleep(0);
			seen.afterAwaitAndMacrotask = runtime.currentExecution() === outer;
			emitter.on("plain", () => {
				seen.plainListener = runtime.currentExecution() === outer;
			});
			emitter.on(
				"bound",
				runtime.bind(() => {
					seen.boundListener = runtime.currentExecution() === outer;
				}),
			);
		});
		emitter.emit("plain"); // emitted outside any context
		emitter.emit("bound");

		expect(seen).toEqual({ afterAwaitAndMacrotask: true, plainListener: false, boundListener: true });
		expect(runtime.currentExecution()).toBeUndefined();
	});

	test("a callback registered outside any execution stays context-free when another session's code fires it", () => {
		const runtime = newRuntime();
		const other = runtime.createSessionExecution(sessionInit({ sessionId: () => "session-other" }));
		let seenWhenFired: ModelRequestExecution | undefined;
		const deferred = runtime.bind(() => {
			seenWhenFired = runtime.currentExecution();
		});

		runtime.runWith(other, deferred);

		expect(seenWhenFired).toBeUndefined();
	});

	test("withPurpose declares a purpose inside a context and does nothing outside one", async () => {
		const runtime = newRuntime();
		const { gate, attempts } = recordingGate(PASS);
		runtime.registerGate("owner", gate, undefined);
		const execution = runtime.createSessionExecution(sessionInit());

		await runtime.withPurpose("title", () => runtime.authorize(INPUT));
		await runtime.runWith(execution, () => runtime.withPurpose("title", () => runtime.authorize(INPUT)));

		expect(attempts.map(a => [a.origin, a.scope?.purpose])).toEqual([
			["unclassified", undefined],
			["session", "title"],
		]);
	});

	test("the self-check of the context mechanism passes on this platform and is reflected in the gate info", async () => {
		const runtime = newRuntime();
		expect(await runtime.verifyContext()).toBe(true);
		expect(runtime.gateInfo().coverage.contextCheck).toBe("passed");
	});
});
