/**
 * Process-wide runtime behind the ModelRequestGate API (internal).
 *
 * One {@link ModelRequestRuntime} owns the gate registration latch, the core
 * execution context (`AsyncLocalStorage` + a `WeakSet` registry of the
 * executions the core minted) and the session-less-process mark. The default
 * instance is shared through `globalThis` so that two copies of this module in
 * one process (an extension that resolves its own copy of `@oh-my-pi/pi-ai`)
 * cannot hold different latches and leave the host's copy unguarded.
 *
 * Tests build isolated instances; production code only ever sees the default.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import type { ModelRequestJournalLeaseBinding } from "@oh-my-pi/pi-utils/model-request-journal-authority";
import { AbortError } from "./error/abort";
import { ModelRequestDeniedError } from "./error/model-request-denied";
import type {
	ModelRequestAgent,
	ModelRequestAttempt,
	ModelRequestGate,
	ModelRequestGateInfo,
	ModelRequestGateOptions,
	ModelRequestKind,
	ModelRequestLease,
	ModelRequestModelRef,
	ModelRequestOutcome,
	ModelRequestPurpose,
	ModelRequestReason,
	ModelRequestScope,
	ModelRequestWire,
} from "./model-request-gate";
import { buildModelRequestCoverage } from "./model-request-coverage";

declare const EXECUTION_BRAND: unique symbol;

/** Opaque handle to a core-minted execution context. Cannot be constructed outside the runtime. */
export interface ModelRequestExecution {
	readonly [EXECUTION_BRAND]: true;
	readonly modelRequestJournalLeaseBinding?: ModelRequestJournalLeaseBinding;
}

/** Where an execution's root session id comes from. */
export type ModelRequestRootSource =
	/** A session the user started or resumed: its root is its own current session id. */
	| { readonly kind: "self"; readonly modelRequestJournalLeaseBinding?: ModelRequestJournalLeaseBinding }
	/** A child session: the parent handed the root over explicitly. `undefined` records a missing hand-over. */
	| {
			readonly kind: "inherited";
			readonly rootSessionId: string | undefined;
			readonly modelRequestJournalLeaseBinding?: ModelRequestJournalLeaseBinding;
	  };

export interface ModelRequestExecutionInit {
	/** Evaluated on every request, so `/new` and session switches are never billed to a stale id. */
	readonly sessionId: () => string;
	readonly root: ModelRequestRootSource;
	readonly agent: ModelRequestAgent;
	readonly purpose: ModelRequestPurpose;
}

/**
 * Fields a derived execution may override. The session id and root are inherited unchanged: a derived
 * execution never changes which root a request is billed to.
 */
export interface ModelRequestExecutionPatch {
	readonly purpose?: ModelRequestPurpose;
	readonly agent?: ModelRequestAgent;
}

/** What the core hands `authorizeModelRequest`. `origin` and `scope` are deliberately absent. */
export interface ModelRequestAuthorizationInput {
	readonly requestId: string;
	readonly reason: ModelRequestReason;
	readonly retryOf?: string;
	readonly kind: ModelRequestKind;
	readonly model: ModelRequestModelRef;
	readonly wire: ModelRequestWire | undefined;
	readonly signal?: AbortSignal;
}

/**
 * Result of {@link ModelRequestRuntime.authorize}. `lease` is undefined when no gate is registered or the
 * gate answered `pass`; the caller then sends without lease bookkeeping.
 */
export interface ModelRequestPermit {
	readonly attemptId: string;
	readonly lease: ModelRequestLease | undefined;
}

export interface ModelRequestRuntimeDeps {
	readonly newAttemptId: () => string;
}

/** Raised when a session is created in a process marked as a session-less command, or the reverse. */
export class ModelRequestProcessClassError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelRequestProcessClassError";
	}
}

type ParsedDecision =
	| { readonly type: "pass" }
	| { readonly type: "allow"; readonly lease: ModelRequestLease }
	| { readonly type: "deny"; readonly code: string; readonly message: string };

type RaceResult = { readonly kind: "decision"; readonly value: unknown } | { readonly kind: "aborted" } | { readonly kind: "timeout" };

interface GateRegistration {
	readonly owner: string;
	readonly gate: ModelRequestGate;
	readonly authorizeTimeoutMs: number | undefined;
}

class ExecutionImpl implements ModelRequestExecution {
	declare readonly [EXECUTION_BRAND]: true;
	readonly #init: ModelRequestExecutionInit;

	constructor(init: ModelRequestExecutionInit) {
		this.#init = init;
	}

	get modelRequestJournalLeaseBinding(): ModelRequestJournalLeaseBinding | undefined {
		return this.#init.root.modelRequestJournalLeaseBinding;
	}

	derive(patch: ModelRequestExecutionPatch): ExecutionImpl {
		return new ExecutionImpl({
			...this.#init,
			purpose: patch.purpose ?? this.#init.purpose,
			agent: patch.agent ?? this.#init.agent,
		});
	}

	/** Builds a fresh, frozen scope. Throws if the session id cannot be resolved. */
	resolveScope(): ModelRequestScope {
		const sessionId = this.#init.sessionId();
		if (typeof sessionId !== "string" || sessionId.length === 0) {
			throw new TypeError("model request execution resolved an empty session id");
		}
		const root = this.#init.root;
		const rootSessionId = root.kind === "self" ? sessionId : root.rootSessionId;
		if (rootSessionId !== undefined && (typeof rootSessionId !== "string" || rootSessionId.length === 0)) {
			throw new TypeError("model request execution resolved an empty root session id");
		}
		const agent = this.#init.agent;
		return Object.freeze({
			rootSessionId,
			sessionId,
			agent: Object.freeze({
				id: agent.id,
				kind: agent.kind,
				name: agent.name,
				depth: agent.depth,
				...(agent.parentId === undefined ? {} : { parentId: agent.parentId }),
			}),
			purpose: this.#init.purpose,
		});
	}
}

/** Wraps a gate-issued lease so the core cannot violate the lease protocol (order, once-only settle). */
class GuardedLease implements ModelRequestLease {
	readonly #lease: ModelRequestLease;
	#begun = false;
	#settled: Promise<void> | undefined;

	constructor(lease: ModelRequestLease) {
		this.#lease = lease;
	}

	beginSend(): void {
		if (this.#settled !== undefined) throw new Error("model request lease: beginSend after settle");
		if (this.#begun) throw new Error("model request lease: beginSend called twice");
		this.#begun = true;
		this.#lease.beginSend();
	}

	observeResponse(head: { readonly status: number; readonly headers: Readonly<Record<string, string>> }): void {
		this.#requireOpenAndBegun("observeResponse");
		this.#lease.observeResponse(head);
	}

	observeChunk(chunk: Uint8Array): void {
		this.#requireOpenAndBegun("observeChunk");
		this.#lease.observeChunk(chunk);
	}

	settle(outcome: ModelRequestOutcome): Promise<void> {
		this.#settled ??= (async () => this.#lease.settle(outcome))();
		return this.#settled;
	}

	#requireOpenAndBegun(operation: string): void {
		if (this.#settled !== undefined) throw new Error(`model request lease: ${operation} after settle`);
		if (!this.#begun) throw new Error(`model request lease: ${operation} before beginSend`);
	}
}

function isLease(value: unknown): value is ModelRequestLease {
	if (typeof value !== "object" || value === null) return false;
	return (
		"beginSend" in value &&
		typeof value.beginSend === "function" &&
		"observeResponse" in value &&
		typeof value.observeResponse === "function" &&
		"observeChunk" in value &&
		typeof value.observeChunk === "function" &&
		"settle" in value &&
		typeof value.settle === "function"
	);
}

function parseDecision(value: unknown): ParsedDecision | undefined {
	if (typeof value !== "object" || value === null || !("type" in value)) return undefined;
	if (value.type === "pass") return { type: "pass" };
	if (value.type === "allow") {
		if (!("lease" in value) || !isLease(value.lease)) return undefined;
		return { type: "allow", lease: value.lease };
	}
	if (value.type === "deny") {
		if (!("code" in value) || typeof value.code !== "string" || value.code.length === 0) return undefined;
		if (!("message" in value) || typeof value.message !== "string") return undefined;
		return { type: "deny", code: value.code, message: value.message };
	}
	return undefined;
}

/** Largest delay a platform timer honors (signed 32-bit); a larger value would fire at once. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function assertTimeout(timeoutMs: number | undefined): void {
	if (timeoutMs === undefined) return;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
		throw new RangeError(
			`authorizeTimeoutMs must be a positive integer number of milliseconds no greater than ${MAX_TIMER_DELAY_MS}`,
		);
	}
}

export class ModelRequestRuntime {
	readonly #als = new AsyncLocalStorage<object>();
	readonly #executions = new WeakSet<object>();
	readonly #localStreams = new WeakSet<object>();
	readonly #deps: ModelRequestRuntimeDeps;
	#registration: GateRegistration | undefined;
	#standalone = false;
	#sessionCreated = false;
	#contextCheck: "pending" | "passed" | "failed" = "pending";
	#contextCheckRun: Promise<boolean> | undefined;

	constructor(deps: ModelRequestRuntimeDeps) {
		this.#deps = deps;
	}

	// ---- gate registration (latch) ----

	registerGate(owner: string, gate: ModelRequestGate, options: ModelRequestGateOptions | undefined): void {
		if (typeof owner !== "string" || owner.length === 0) throw new TypeError("gate owner must be a non-empty string");
		if (typeof gate !== "object" || gate === null || typeof gate.authorize !== "function") {
			throw new TypeError("gate must implement authorize()");
		}
		const authorizeTimeoutMs = options?.authorizeTimeoutMs;
		assertTimeout(authorizeTimeoutMs);
		const existing = this.#registration;
		if (existing !== undefined) {
			if (existing.owner === owner && existing.gate === gate && existing.authorizeTimeoutMs === authorizeTimeoutMs) {
				return;
			}
			throw new Error(`a model request gate is already registered by "${existing.owner}"; it cannot be replaced or removed`);
		}
		this.#registration = Object.freeze({ owner, gate, authorizeTimeoutMs });
		void this.verifyContext();
	}

	/** Whether a gate is registered. Request paths check this first so an ungated process does no extra work. */
	hasGate(): boolean {
		return this.#registration !== undefined;
	}

	gateInfo(): ModelRequestGateInfo {
		if (this.#contextCheck === "pending") void this.verifyContext();
		return {
			apiVersion: 1,
			registered: this.#registration !== undefined,
			coverage: buildModelRequestCoverage(this.#contextCheck),
		};
	}

	// ---- in-process transports ----

	/**
	 * Declare that `stream` is a transport that never leaves the process (an on-device model). Identified by the
	 * function itself, not by the API name it is registered under, so registering a different function under the
	 * same name does not inherit the exemption.
	 */
	markLocalStream(stream: (...args: never[]) => unknown): void {
		this.#localStreams.add(stream);
	}

	isLocalStream(stream: (...args: never[]) => unknown): boolean {
		return this.#localStreams.has(stream);
	}

	// ---- process classification ----

	/**
	 * Mark this process as a session-less command. Only the core's command entry points call this, before
	 * any session exists; it fails if a session context was already created.
	 */
	markStandalone(): void {
		if (this.#sessionCreated) {
			throw new ModelRequestProcessClassError("cannot mark a process standalone after a session was created");
		}
		this.#standalone = true;
	}

	isStandalone(): boolean {
		return this.#standalone;
	}

	// ---- execution context ----

	/** Mint the context of a session being created. A standalone-marked process cannot create sessions. */
	createSessionExecution(init: ModelRequestExecutionInit): ModelRequestExecution {
		if (this.#standalone) {
			throw new ModelRequestProcessClassError("a process marked standalone cannot create a session");
		}
		this.#sessionCreated = true;
		return this.#register(new ExecutionImpl(init));
	}

	/** Derive an execution from a core-minted one (same session identity, patched purpose). */
	deriveExecution(parent: ModelRequestExecution, patch: ModelRequestExecutionPatch): ModelRequestExecution {
		return this.#register(this.#require(parent).derive(patch));
	}

	/** Current execution, or undefined when none is active or the stored object was not minted by the core. */
	currentExecution(): ModelRequestExecution | undefined {
		const stored = this.#als.getStore();
		if (stored === undefined || !this.#executions.has(stored)) return undefined;
		return stored instanceof ExecutionImpl ? stored : undefined;
	}

	runWith<T>(execution: ModelRequestExecution, fn: () => T): T {
		return this.#als.run(this.#require(execution), fn);
	}

	/** Run `fn` with a different purpose when an execution is active; otherwise run it unchanged. */
	withPurpose<T>(purpose: ModelRequestPurpose, fn: () => T): T {
		const current = this.currentExecution();
		if (current === undefined) return fn();
		return this.runWith(this.deriveExecution(current, { purpose }), fn);
	}

	/**
	 * Capture the active execution and return `fn` re-bound to it. For listeners, timers and queued jobs that
	 * run later from a different (emit-side or timer-side) context. Registered outside any execution, `fn` is
	 * pinned to "no execution" instead, so it never picks up whichever session happens to emit or fire it.
	 */
	bind<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
		const captured = this.currentExecution();
		if (captured === undefined) return (...args: A) => this.#als.exit(() => fn(...args));
		return (...args: A) => this.runWith(captured, () => fn(...args));
	}

	/** Resolve the scope of a core-minted execution as of now. */
	scopeOf(execution: ModelRequestExecution): ModelRequestScope {
		return this.#require(execution).resolveScope();
	}

	#register(execution: ExecutionImpl): ExecutionImpl {
		this.#executions.add(execution);
		return execution;
	}

	#require(execution: ModelRequestExecution): ExecutionImpl {
		if (!(execution instanceof ExecutionImpl) || !this.#executions.has(execution)) {
			throw new TypeError("not a core-minted model request execution");
		}
		return execution;
	}

	// ---- per-attempt authorization ----

	/**
	 * Ask the registered gate whether one wire attempt may be sent. An ordinary sinkless execution with no gate
	 * resolves to a permit without a lease. Managed executions require an authenticated journal connection;
	 * `deny` and every gate failure throw, and the caller MUST NOT start any I/O.
	 */
	async authorize(input: ModelRequestAuthorizationInput): Promise<ModelRequestPermit> {
		const execution = this.currentExecution();
		if (execution?.modelRequestJournalLeaseBinding !== undefined) {
			// WIP boundary: r8 has not yet supplied an authenticated bridge from the manager's actual
			// registry/header/owner receipt to this exact execution. An init promise is not that proof.
			throw new ModelRequestDeniedError(
				"gate-error",
				"authenticated model request journal execution connection is unavailable",
			);
		}
		const registration = this.#registration;
		const attemptId = this.#deps.newAttemptId();
		if (registration === undefined) return { attemptId, lease: undefined };

		const signal = input.signal;
		if (signal?.aborted) throw signal.reason ?? new AbortError("model request aborted before authorization");

		const attempt = this.#buildAttempt(attemptId, input);
		const raced = await this.#raceGate(registration, attempt);

		if (raced.kind === "aborted") {
			throw signal?.reason ?? new AbortError("model request aborted while awaiting authorization");
		}
		if (raced.kind === "timeout") {
			throw new ModelRequestDeniedError("gate-error", "model request gate did not answer within the configured timeout");
		}
		const decision = parseDecision(raced.value);
		if (decision === undefined) {
			throw new ModelRequestDeniedError("gate-error", "model request gate returned an unrecognizable decision");
		}
		if (decision.type === "deny") throw new ModelRequestDeniedError(decision.code, decision.message);
		if (signal?.aborted) {
			if (decision.type === "allow") this.#releaseUnused(decision.lease, true);
			throw signal.reason ?? new AbortError("model request aborted after authorization");
		}
		if (decision.type === "pass") return { attemptId, lease: undefined };
		return { attemptId, lease: new GuardedLease(decision.lease) };
	}

	#buildAttempt(attemptId: string, input: ModelRequestAuthorizationInput): ModelRequestAttempt {
		const execution = this.currentExecution();
		let origin: ModelRequestAttempt["origin"];
		let scope: ModelRequestScope | undefined;
		if (execution !== undefined) {
			origin = "session";
			try {
				scope = this.scopeOf(execution);
			} catch (error) {
				throw new ModelRequestDeniedError("gate-error", "model request scope could not be resolved", { cause: error });
			}
		} else if (this.#standalone) {
			origin = "standalone";
		} else {
			origin = "unclassified";
		}
		return Object.freeze({
			attemptId,
			requestId: input.requestId,
			...(input.retryOf === undefined ? {} : { retryOf: input.retryOf }),
			reason: input.reason,
			origin,
			scope,
			kind: input.kind,
			model: input.model,
			wire: input.wire,
			...(input.signal === undefined ? {} : { signal: input.signal }),
		});
	}

	async #raceGate(registration: GateRegistration, attempt: ModelRequestAttempt): Promise<RaceResult> {
		const gateCall = (async () => registration.gate.authorize(attempt))();
		const { promise: interrupt, resolve: interruptWith } = Promise.withResolvers<RaceResult>();
		// Set the moment the caller stops waiting, so an answer that lands afterwards is released, not used.
		let raceOver = false;
		const interruptBy = (result: RaceResult) => {
			raceOver = true;
			interruptWith(result);
		};
		const onAbort = () => interruptBy({ kind: "aborted" });
		const timer =
			registration.authorizeTimeoutMs === undefined
				? undefined
				: setTimeout(() => interruptBy({ kind: "timeout" }), registration.authorizeTimeoutMs);
		attempt.signal?.addEventListener("abort", onAbort, { once: true });
		// An answer that arrives after the race was lost still holds a reservation: release it.
		gateCall.then(
			value => {
				if (raceOver) {
					const late = parseDecision(value);
					if (late?.type === "allow") this.#releaseUnused(late.lease, attempt.signal?.aborted === true);
				}
			},
			() => {},
		);
		try {
			return await Promise.race([
				gateCall.then((value): RaceResult => ({ kind: "decision", value })),
				interrupt,
			]).catch(error => {
				throw new ModelRequestDeniedError("gate-error", "model request gate failed while authorizing", { cause: error });
			});
		} finally {
			raceOver = true;
			clearTimeout(timer);
			attempt.signal?.removeEventListener("abort", onAbort);
		}
	}

	#releaseUnused(lease: ModelRequestLease, aborted: boolean): void {
		void (async () => lease.settle({ type: "not-sent", aborted }))().catch(() => {});
	}

	// ---- self-check of the context mechanism ----

	/**
	 * Verify, on this process, the properties the design relies on: the context survives awaits, timers and
	 * microtasks, returns to the outer context after a nested run, is absent outside any run, ignores a stored
	 * object the core did not mint, and follows the emit side (not the listener-registration side) through an
	 * EventEmitter. Cached after the first run.
	 */
	verifyContext(): Promise<boolean> {
		this.#contextCheckRun ??= this.#runContextCheck().then(
			passed => {
				this.#contextCheck = passed ? "passed" : "failed";
				return passed;
			},
			() => {
				this.#contextCheck = "failed";
				return false;
			},
		);
		return this.#contextCheckRun;
	}

	#runContextCheck(): Promise<boolean> {
		// Judge the mechanism from outside whatever context the registering caller happens to be in.
		return this.#als.exit(() => this.#probeContext());
	}

	async #probeContext(): Promise<boolean> {
		const init = (id: string): ModelRequestExecutionInit => ({
			sessionId: () => id,
			root: { kind: "self" },
			agent: { id, kind: "main", name: id, depth: 0 },
			purpose: "other",
		});
		const outer = this.#register(new ExecutionImpl(init("context-check-outer")));
		const inner = this.#register(new ExecutionImpl(init("context-check-inner")));
		const sameAs = (expected: ModelRequestExecution | undefined) => this.currentExecution() === expected;

		if (!sameAs(undefined)) return false;

		const inRun = await this.runWith(outer, async () => {
			if (!sameAs(outer)) return false;
			await Promise.resolve();
			if (!sameAs(outer)) return false;
			await Bun.sleep(0);
			if (!sameAs(outer)) return false;
			const microtask = Promise.withResolvers<boolean>();
			queueMicrotask(() => microtask.resolve(sameAs(outer)));
			if (!(await microtask.promise)) return false;
			const nested = await this.runWith(inner, async () => {
				await Promise.resolve();
				return sameAs(inner);
			});
			return nested && sameAs(outer);
		});
		if (!inRun || !sameAs(undefined)) return false;

		// A stored object the core did not mint is not a context.
		const forged = await this.#als.run({ forged: true }, async () => {
			await Promise.resolve();
			return this.currentExecution() === undefined;
		});
		if (!forged) return false;

		// EventEmitter listeners run in the context of the emit side, not of the registration side.
		const emitter = new EventEmitter();
		const seen: Array<ModelRequestExecution | undefined> = [];
		this.runWith(outer, () => emitter.on("registered-inside", () => seen.push(this.currentExecution())));
		emitter.emit("registered-inside");
		const registeredOutsideSeen: Array<ModelRequestExecution | undefined> = [];
		emitter.on("registered-outside", () => registeredOutsideSeen.push(this.currentExecution()));
		this.runWith(inner, () => emitter.emit("registered-outside"));
		return seen.length === 1 && seen[0] === undefined && registeredOutsideSeen.length === 1 && registeredOutsideSeen[0] === inner;
	}
}

const RUNTIME_KEY = Symbol.for("omp.modelRequestRuntime.v1");

function isRuntime(value: unknown): value is ModelRequestRuntime {
	return (
		typeof value === "object" &&
		value !== null &&
		"authorize" in value &&
		typeof value.authorize === "function" &&
		"registerGate" in value &&
		typeof value.registerGate === "function"
	);
}

/** The process-wide runtime, shared across module copies through `globalThis`. */
export function getModelRequestRuntime(): ModelRequestRuntime {
	const existing: unknown = Reflect.get(globalThis, RUNTIME_KEY);
	if (isRuntime(existing)) return existing;
	if (existing !== undefined) throw new Error("globalThis holds a non-runtime value under the model request runtime key");
	const created = new ModelRequestRuntime({ newAttemptId: () => crypto.randomUUID() });
	Reflect.set(globalThis, RUNTIME_KEY, created);
	return created;
}
