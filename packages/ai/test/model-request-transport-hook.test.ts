import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { Buffer } from "node:buffer";
import { setImmediate } from "node:timers/promises";
import { registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import {
	type ModelRequestAttempt,
	type ModelRequestDecision,
	ModelRequestDeniedError,
	type ModelRequestWire,
} from "@oh-my-pi/pi-ai/model-request-gate";
import type { ModelRequestModelRef } from "@oh-my-pi/pi-utils/model-request-data";
import { complete, completeSimple, stream, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type {
	AssistantMessageEvent,
	Context,
	FetchImpl,
	Model,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai/types";
import type { Api, AssistantMessage, Usage } from "@oh-my-pi/pi-utils/model-data";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import * as bedrockProvider from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import * as cursorProvider from "@oh-my-pi/pi-ai/providers/cursor";
import * as gitlabWorkflowProvider from "@oh-my-pi/pi-ai/providers/gitlab-duo-workflow";
import { setBedrockProviderModule, setCursorProviderModule } from "@oh-my-pi/pi-ai/providers/register-builtins";
import { gateFetch } from "@oh-my-pi/pi-ai/utils/model-request-fetch";
import { transportFetch } from "@oh-my-pi/pi-ai/utils/transport-fetch";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	type FixtureGateHandler,
	installFixtureGate,
	type RecordingLease,
	recordingLease,
} from "./helpers/model-request-gate-fixture";
import {
	errorReply,
	helloContext,
	type LoopbackApi,
	type LoopbackProvider,
	type LoopbackReply,
	type LoopbackRequest,
	type LoopbackResponder,
	loopbackModel,
	replyBody,
	scripted,
	startLoopbackProvider,
	textReplyFor,
} from "./helpers/model-request-loopback";

/**
 * The per-attempt hook, seen from the consumer: the real pi-ai entries drive the real provider code against a
 * loopback fake provider, and the registered gate must be asked about every wire attempt before a byte leaves.
 */

const gate = installFixtureGate();

const SECRET = "sk-loopback-secret-0123456789";
const REPLY_TEXT = "hello from the loopback";
const APIS: readonly LoopbackApi[] = ["anthropic-messages", "openai-completions", "openai-responses"];

/** Answers a gate can give that break the ModelRequestGate contract; each must end as a `gate-error` denial. */
const OUT_OF_CONTRACT_ANSWERS: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
	["throws", () => Promise.reject(new Error("db locked"))],
	["resolves an unknown decision type", () => Promise.resolve({ type: "maybe" })],
	["allows without a usable lease", () => Promise.resolve({ type: "allow", lease: { beginSend() {} } })],
	["denies without a code", () => Promise.resolve({ type: "deny", message: "no" })],
];

interface WireOptions {
	readonly apiKey: string;
	readonly signal?: AbortSignal;
	readonly providerRetryWait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

/** What a caller of an entry point ends up holding: a resolved message, or whatever the entry threw. */
interface Result {
	readonly message: AssistantMessage | undefined;
	readonly thrown: unknown;
}

interface Entry {
	readonly name: "stream" | "streamSimple" | "complete" | "completeSimple";
	run(model: Model<Api>, context: Context, options: WireOptions): Promise<Result>;
}

async function drained(events: AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> }) {
	for await (const _event of events) {
		// The caller consumes every event.
	}
	return events.result();
}

async function observed(run: () => Promise<AssistantMessage>): Promise<Result> {
	try {
		return { message: await run(), thrown: undefined };
	} catch (thrown) {
		return { message: undefined, thrown };
	}
}

const ENTRIES: readonly Entry[] = [
	{ name: "stream", run: (model, context, options) => observed(() => drained(stream(model, context, options))) },
	{
		name: "streamSimple",
		run: (model, context, options) => observed(() => drained(streamSimple(model, context, options))),
	},
	{ name: "complete", run: (model, context, options) => observed(() => complete(model, context, options)) },
	{
		name: "completeSimple",
		run: (model, context, options) => observed(() => completeSimple(model, context, options)),
	},
];

/** The simple entries are the ones that accept a credential resolver. */
const SIMPLE_ENTRIES = ENTRIES.filter(entry => entry.name === "streamSimple" || entry.name === "completeSimple");

function textOf(message: AssistantMessage | undefined): string {
	return (message?.content ?? []).flatMap(block => (block.type === "text" ? [block.text] : [])).join("");
}

/** The error text a caller sees, whether the entry resolved an error message or threw. */
function errorTextOf(result: Result): string {
	if (result.message?.errorMessage !== undefined) return result.message.errorMessage;
	return result.thrown instanceof Error ? result.thrown.message : String(result.thrown);
}

function isDenied(result: Result): boolean {
	return AIError.isModelRequestDenied(result.message ?? result.thrown);
}

function wireOf(attempt: ModelRequestAttempt): ModelRequestWire {
	if (attempt.wire === undefined) throw new Error("expected the attempt to carry a readable wire");
	return attempt.wire;
}

function modelRefOf(model: Model<Api>): ModelRequestModelRef {
	return { provider: model.provider, id: model.id, api: model.api, baseUrl: model.baseUrl };
}

let servers: LoopbackProvider[] = [];

function serve(responder: LoopbackResponder, trace?: string[]): LoopbackProvider {
	const provider = startLoopbackProvider(responder, trace === undefined ? {} : { trace });
	servers.push(provider);
	return provider;
}

beforeEach(() => {
	gate.reset();
});

afterEach(() => {
	gate.reset();
	for (const server of servers) server.stop();
	servers = [];
});

/** A gate that allows every attempt under a fresh recording lease, kept in `leases`. */
function allowEachAttempt(trace?: string[]): RecordingLease[] {
	const leases: RecordingLease[] = [];
	gate.setHandler(async () => {
		trace?.push("authorize");
		const lease = recordingLease(trace);
		leases.push(lease);
		return { type: "allow", lease: lease.lease };
	});
	return leases;
}

function lastLease(leases: readonly RecordingLease[]): RecordingLease {
	const lease = leases.at(-1);
	if (lease === undefined) throw new Error("the gate allowed no attempt");
	return lease;
}

/** Yield to the event loop so a settle the core wrongly repeated has reached the lease before it is counted. */
async function afterSettling(): Promise<void> {
	await setImmediate();
}

function expectNoCredentialOnWire(wire: ModelRequestWire, received: LoopbackRequest): void {
	// The credential did travel on the wire the loopback saw ...
	const carried = `${received.headers["x-api-key"] ?? ""}${received.headers.authorization ?? ""}`;
	expect(carried).toContain(SECRET);
	// ... and none of it is shown to the gate.
	for (const name of Object.keys(wire.headers)) expect(name).not.toMatch(/authorization|x-api-key/i);
	expect(Object.values(wire.headers).join("\n")).not.toContain(SECRET);
	expect(wire.url).not.toContain(SECRET);
	const url = new URL(wire.url);
	expect(url.username).toBe("");
	expect(url.password).toBe("");
}

for (const api of APIS) {
	describe(`${api} through the real entries`, () => {
		for (const entry of ENTRIES) {
			describe(entry.name, () => {
				test("pass: each wire attempt reaches the gate first with a credential-free description of exactly what was sent", async () => {
					const trace: string[] = [];
					const loopback = serve(scripted(textReplyFor(api, REPLY_TEXT)), trace);
					const model = loopbackModel(api, loopback.origin);
					gate.setHandler(async () => {
						trace.push("authorize");
						return { type: "pass" };
					});

					const result = await entry.run(model, helloContext(), { apiKey: SECRET });

					expect(result.message?.stopReason).toBe("stop");
					expect(textOf(result.message)).toBe(REPLY_TEXT);
					expect(trace).toEqual(["authorize", "loopback-request"]);
					expect(gate.attempts).toHaveLength(1);
					expect(loopback.requests).toHaveLength(1);

					const attempt = gate.attempts[0]!;
					const received = loopback.requests[0]!;
					const wire = wireOf(attempt);
					expect(attempt.kind).toBe("chat");
					expect(attempt.reason).toBe("first");
					expect(attempt.retryOf).toBeUndefined();
					expect(attempt.model).toEqual(modelRefOf(model));
					expect(wire.method).toBe("POST");
					const url = new URL(wire.url);
					expect(url.origin).toBe(loopback.origin);
					expect(`${url.pathname}${url.search}`).toBe(received.target);
					expect(wire.bodyBytes).toBe(received.body.byteLength);
					expect(wire.bodyBytes).toBeGreaterThan(0);
					expect(Buffer.from(await wire.readBody()).equals(received.body)).toBe(true);
					for (const [name, value] of Object.entries(wire.headers)) expect(received.headers[name]).toBe(value);
					expectNoCredentialOnWire(wire, received);
				});

				test("allow: the lease is told beginSend before the loopback sees the request, then the response, every chunk, and one response-ended", async () => {
					const trace: string[] = [];
					const reply = textReplyFor(api, REPLY_TEXT);
					const loopback = serve(scripted(reply), trace);
					const leases = allowEachAttempt(trace);

					const result = await entry.run(loopbackModel(api, loopback.origin), helloContext(), { apiKey: SECRET });
					const lease = lastLease(leases);
					const outcome = await lease.firstSettle;
					await afterSettling();

					expect(textOf(result.message)).toBe(REPLY_TEXT);
					expect(leases).toHaveLength(1);
					expect(trace).toEqual(["authorize", "beginSend", "loopback-request", "observeResponse", "settle"]);
					expect(lease.events.filter(event => event.type === "beginSend")).toHaveLength(1);
					const head = lease.events.find(event => event.type === "observeResponse");
					expect(head).toMatchObject({ type: "observeResponse", status: 200 });
					expect(Buffer.from(lease.observedBytes()).toString()).toBe(replyBody(reply));
					expect(lease.events.filter(event => event.type === "observeChunk").length).toBeGreaterThan(0);
					expect(outcome).toEqual({ type: "response-ended", status: 200 });
					expect(lease.settled).toEqual([{ type: "response-ended", status: 200 }]);
				});

				test("deny: no request reaches the loopback and the caller gets a terminal denial carrying the gate's wording", async () => {
					const loopback = serve(scripted(textReplyFor(api, REPLY_TEXT)));
					const wording = "gate says no: 429 usage limit reached, 503 overloaded";
					gate.setHandler(async () => ({ type: "deny", code: "loopback-denied", message: wording }));

					const result = await entry.run(loopbackModel(api, loopback.origin), helloContext(), { apiKey: SECRET });

					expect(loopback.requests).toHaveLength(0);
					expect(isDenied(result)).toBe(true);
					expect(errorTextOf(result)).toContain(wording);
					expect(result.message?.stopReason ?? "error").toBe("error");
					// Terminal: the denial is not retried, rotated or resent.
					expect(gate.attempts).toHaveLength(1);
				});

				test.each(OUT_OF_CONTRACT_ANSWERS)(
					"a gate that %s: nothing reaches the loopback, the caller gets a terminal gate-error denial, and the gate is asked exactly once",
					async (_name, answer) => {
						const loopback = serve(scripted(textReplyFor(api, REPLY_TEXT)));
						// Intentional: models an out-of-contract gate (the types cannot express a lying implementation).
						const lying: unknown = answer;
						gate.setHandler(lying as FixtureGateHandler);

						const result = await entry.run(loopbackModel(api, loopback.origin), helloContext(), { apiKey: SECRET });

						expect(loopback.requests).toHaveLength(0);
						expect(isDenied(result)).toBe(true);
						if (result.thrown instanceof AIError.ModelRequestDeniedError) expect(result.thrown.code).toBe("gate-error");
						// Terminal: a gate failure is not retried or resent.
						expect(gate.attempts).toHaveLength(1);
					},
				);

				test("allow then the caller aborts before any response: the lease settles once as an aborted failure and nothing more is sent", async () => {
					const release = Promise.withResolvers<void>();
					const loopback = serve(scripted({ ...textReplyFor(api, REPLY_TEXT), holdUntil: release.promise }));
					const leases = allowEachAttempt();
					const abort = new AbortController();

					const pending = entry.run(loopbackModel(api, loopback.origin), helloContext(), {
						apiKey: SECRET,
						signal: abort.signal,
					});
					await loopback.arrived(1);
					abort.abort();
					const result = await pending;
					const outcome = await lastLease(leases).firstSettle;
					release.resolve();
					await afterSettling();

					expect(result.message?.stopReason ?? "aborted").toBe("aborted");
					expect(outcome).toMatchObject({ type: "request-failed", sent: "maybe", aborted: true });
					expect(lastLease(leases).settled).toHaveLength(1);
					expect(leases).toHaveLength(1);
					expect(loopback.requests).toHaveLength(1);
				});

				test("allow then the response breaks mid-body: the lease sees the bytes that did arrive and settles once as response-failed", async () => {
					const full = textReplyFor(api, REPLY_TEXT);
					const broken: LoopbackReply = { ...full, chunks: full.chunks.slice(0, 2), dropAfterChunks: true };
					const loopback = serve(scripted(broken));
					const leases = allowEachAttempt();

					const result = await entry.run(loopbackModel(api, loopback.origin), helloContext(), {
						apiKey: SECRET,
						providerRetryWait: async () => {},
					});
					const lease = lastLease(leases);
					const outcome = await lease.firstSettle;
					await afterSettling();

					expect(result.message?.stopReason ?? "error").toBe("error");
					expect(outcome).toMatchObject({ type: "response-failed", status: 200, aborted: false });
					expect(lease.settled).toHaveLength(1);
					expect(Buffer.from(lease.observedBytes()).toString()).toBe(broken.chunks.join(""));
				});

				test("a gate that never answers keeps the request off the wire until the caller aborts", async () => {
					const loopback = serve(scripted(textReplyFor(api, REPLY_TEXT)));
					const asked = Promise.withResolvers<void>();
					gate.setHandler(() => {
						asked.resolve();
						return Promise.withResolvers<ModelRequestDecision>().promise;
					});
					const abort = new AbortController();

					const pending = entry.run(loopbackModel(api, loopback.origin), helloContext(), {
						apiKey: SECRET,
						signal: abort.signal,
					});
					await asked.promise;
					// The gate holds the only decision; the core has nothing to send until it answers.
					expect(loopback.requests).toHaveLength(0);
					abort.abort();
					const result = await pending;

					expect(loopback.requests).toHaveLength(0);
					expect(result.message?.stopReason ?? "aborted").toBe("aborted");
				});
			});
		}
	});
}

describe("anthropic-messages provider-internal retries", () => {
	const retryable = [529, 503] as const;
	for (const status of retryable) {
		for (const entry of ENTRIES) {
			test(`${entry.name}: a ${status} then a 200 is two wire attempts, first then provider-retry, each authorized before it is sent`, async () => {
				const trace: string[] = [];
				const loopback = serve(
					scripted(errorReply(status, "Overloaded"), textReplyFor("anthropic-messages", REPLY_TEXT)),
					trace,
				);
				const leases = allowEachAttempt(trace);

				const result = await entry.run(loopbackModel("anthropic-messages", loopback.origin), helloContext(), {
					apiKey: SECRET,
					providerRetryWait: async () => {},
				});
				await Promise.all(leases.map(lease => lease.firstSettle));
				await afterSettling();

				expect(textOf(result.message)).toBe(REPLY_TEXT);
				expect(loopback.requests).toHaveLength(2);
				expect(gate.attempts.map(attempt => attempt.reason)).toEqual(["first", "provider-retry"]);
				const [first, second] = gate.attempts;
				expect(first?.retryOf).toBeUndefined();
				expect(second?.retryOf).toBe(first?.attemptId);
				expect(second?.attemptId).not.toBe(first?.attemptId);
				expect(second?.requestId).toBe(first?.requestId);
				expect(trace).toEqual([
					"authorize",
					"beginSend",
					"loopback-request",
					"observeResponse",
					"settle",
					"authorize",
					"beginSend",
					"loopback-request",
					"observeResponse",
					"settle",
				]);
				expect(leases.map(lease => lease.settled)).toEqual([
					[{ type: "response-ended", status }],
					[{ type: "response-ended", status: 200 }],
				]);
				for (const attempt of gate.attempts) {
					expect(wireOf(attempt).method).toBe("POST");
					expect(attempt.kind).toBe("chat");
				}
			});
		}
	}

	test("a denied first attempt is not retried even when the gate's wording looks like an overload", async () => {
		const loopback = serve(scripted(textReplyFor("anthropic-messages", REPLY_TEXT)));
		gate.setHandler(async () => ({ type: "deny", code: "no", message: "503 overloaded_error: Overloaded" }));

		const result = await ENTRIES[3]!.run(loopbackModel("anthropic-messages", loopback.origin), helloContext(), {
			apiKey: SECRET,
			providerRetryWait: async () => {},
		});

		expect(isDenied(result)).toBe(true);
		expect(gate.attempts).toHaveLength(1);
		expect(loopback.requests).toHaveLength(0);
	});
});

describe("thinking-loop re-sampling reaches the gate as a separate attempt", () => {
	const RUNAWAY_UNIT = "Still checking the same thing again before I answer. ";
	const RUNAWAY_TEXT = `Healthy lead sentence. ${RUNAWAY_UNIT.repeat(8)}`;
	const resamplingEntries = ENTRIES.filter(entry => entry.name === "complete" || entry.name === "completeSimple");

	for (const api of APIS) {
		for (const entry of resamplingEntries) {
			test(`${api} ${entry.name}: a runaway answer then a good one is first then thinking-loop-retry of the same logical request`, async () => {
				const loopback = serve(scripted(textReplyFor(api, RUNAWAY_TEXT), textReplyFor(api, REPLY_TEXT)));

				const result = await entry.run(loopbackModel(api, loopback.origin), helloContext(), { apiKey: SECRET });

				expect(textOf(result.message)).toBe(REPLY_TEXT);
				expect(loopback.requests).toHaveLength(2);
				expect(gate.attempts.map(attempt => attempt.reason)).toEqual(["first", "thinking-loop-retry"]);
				expect(gate.attempts[1]?.retryOf).toBe(gate.attempts[0]?.attemptId);
				expect(gate.attempts[1]?.requestId).toBe(gate.attempts[0]?.requestId);
			});
		}
	}

	test("a denied first attempt is not re-sampled", async () => {
		const loopback = serve(scripted(textReplyFor("openai-completions", REPLY_TEXT)));
		gate.setHandler(async () => ({ type: "deny", code: "no", message: "Thinking loop detected, stream stall" }));

		const result = await ENTRIES[3]!.run(loopbackModel("openai-completions", loopback.origin), helloContext(), {
			apiKey: SECRET,
		});

		expect(isDenied(result)).toBe(true);
		expect(gate.attempts).toHaveLength(1);
		expect(loopback.requests).toHaveLength(0);
	});
});

describe("credential rotation reaches the gate as a separate attempt", () => {
	for (const api of APIS) {
		for (const entry of SIMPLE_ENTRIES) {
			test(`${api} ${entry.name}: a 401 then a rotated key is first then auth-rotation with the rotated credential never shown`, async () => {
				const loopback = serve(scripted(errorReply(401, "invalid api key"), textReplyFor(api, REPLY_TEXT)));
				const leases = allowEachAttempt();
				const resolved: string[] = [];
				const apiKey: SimpleStreamOptions["apiKey"] = async context => {
					const key = context.error === undefined ? "sk-rotation-key-0" : "sk-rotation-key-1";
					resolved.push(key);
					return key;
				};
				const model = loopbackModel(api, loopback.origin);

				const result = await observed(() =>
					entry.name === "streamSimple"
						? drained(streamSimple(model, helloContext(), { apiKey }))
						: completeSimple(model, helloContext(), { apiKey }),
				);
				await Promise.all(leases.map(lease => lease.firstSettle));

				expect(textOf(result.message)).toBe(REPLY_TEXT);
				expect(resolved).toEqual(["sk-rotation-key-0", "sk-rotation-key-1"]);
				expect(loopback.requests).toHaveLength(2);
				expect(gate.attempts.map(attempt => attempt.reason)).toEqual(["first", "auth-rotation"]);
				expect(gate.attempts[1]?.retryOf).toBe(gate.attempts[0]?.attemptId);
				expect(gate.attempts[1]?.requestId).toBe(gate.attempts[0]?.requestId);
				const carried = loopback.requests.map(
					request => `${request.headers["x-api-key"] ?? ""}${request.headers.authorization ?? ""}`,
				);
				expect(carried[0]).toContain("sk-rotation-key-0");
				expect(carried[1]).toContain("sk-rotation-key-1");
				for (const attempt of gate.attempts) {
					const shown = JSON.stringify(wireOf(attempt).headers);
					expect(shown).not.toContain("sk-rotation-key");
				}
			});
		}
	}

	test("a denial of the first attempt does not rotate the credential or reach the loopback", async () => {
		const loopback = serve(scripted(textReplyFor("openai-completions", REPLY_TEXT)));
		gate.setHandler(async () => ({ type: "deny", code: "no", message: "401 invalid api key, try another credential" }));
		const resolved: string[] = [];
		const apiKey: SimpleStreamOptions["apiKey"] = async context => {
			resolved.push(context.error === undefined ? "first" : "rotated");
			return `sk-denied-${resolved.length}`;
		};

		const result = await observed(() =>
			completeSimple(loopbackModel("openai-completions", loopback.origin), helloContext(), { apiKey }),
		);

		expect(isDenied(result)).toBe(true);
		expect(resolved).toEqual(["first"]);
		expect(gate.attempts).toHaveLength(1);
		expect(loopback.requests).toHaveLength(0);
	});
});

describe("request bodies the core cannot read", () => {
	const MODEL_REF: ModelRequestModelRef = { provider: "loopback", id: "m", api: "loopback-api" };

	function unreadableBodies(): ReadonlyArray<{
		readonly name: string;
		readonly send: (fetch: FetchImpl, url: string) => Promise<Response>;
	}> {
		return [
			{
				name: "a ReadableStream body",
				send: (fetch, url) =>
					fetch(url, {
						method: "POST",
						duplex: "half",
						body: new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(new TextEncoder().encode("streamed"));
								controller.close();
							},
						}),
					}),
			},
			{
				name: "a FormData body",
				send: (fetch, url) => {
					const form = new FormData();
					form.set("field", "value");
					return fetch(url, { method: "POST", body: form });
				},
			},
			{
				name: "a Request that carries its own body",
				send: (fetch, url) => fetch(new Request(url, { method: "POST", body: "owned" })),
			},
		];
	}

	const gates: ReadonlyArray<{ readonly name: string; readonly build: (base: FetchImpl, origin: string) => FetchImpl }> = [
		{ name: "gateFetch", build: base => gateFetch(MODEL_REF, "chat", base) },
		{
			name: "transportFetch",
			build: (base, origin) => transportFetch(loopbackModel("openai-completions", origin), base),
		},
	];

	for (const gated of gates) {
		for (const body of unreadableBodies()) {
			test(`${gated.name}: ${body.name} is asked about with no wire, and the gate's transport-unsupported denial keeps it off the loopback`, async () => {
				const loopback = serve(scripted({ status: 200, chunks: ["ok"] }));
				gate.setHandler(async attempt =>
					attempt.wire === undefined
						? { type: "deny", code: "transport-unsupported", message: "body not readable" }
						: { type: "pass" },
				);
				const fetch = gated.build((input, init) => globalThis.fetch(input, init), loopback.origin);

				const error = await body.send(fetch, `${loopback.origin}/upload`).then(
					() => undefined,
					(thrown: unknown) => thrown,
				);

				expect(gate.attempts).toHaveLength(1);
				expect(gate.attempts[0]?.wire).toBeUndefined();
				expect(gate.attempts[0]?.kind).toBe("chat");
				expect(error).toBeInstanceOf(ModelRequestDeniedError);
				expect(error instanceof ModelRequestDeniedError ? error.code : undefined).toBe("transport-unsupported");
				expect(AIError.isModelRequestDenied(error)).toBe(true);
				expect(loopback.requests).toHaveLength(0);
			});
		}
	}

	test("with the default fixture gate (pass), an unreadable body is asked about once and reaches the loopback intact", async () => {
		const loopback = serve(scripted({ status: 200, chunks: ["ok"] }));
		const fetch = gateFetch(MODEL_REF, "chat", (input, init) => globalThis.fetch(input, init));

		const response = await unreadableBodies()[0]!.send(fetch, `${loopback.origin}/upload`);

		expect(await response.text()).toBe("ok");
		expect(gate.attempts).toHaveLength(1);
		expect(gate.attempts[0]?.wire).toBeUndefined();
		expect(loopback.requests).toHaveLength(1);
		expect(new TextDecoder().decode(loopback.requests[0]?.body)).toBe("streamed");
	});

	test("a gate that allows an unreadable body gets a lease: it is sent, observed and settled once, and the gate sees only that a body existed", async () => {
		const loopback = serve(scripted({ status: 200, chunks: ["ok"] }));
		const fetch = gateFetch(MODEL_REF, "chat", (input, init) => globalThis.fetch(input, init));
		const leases = allowEachAttempt();

		const response = await unreadableBodies()[0]!.send(fetch, `${loopback.origin}/upload`);
		expect(await response.text()).toBe("ok");
		await afterSettling();

		expect(gate.attempts).toHaveLength(1);
		expect(gate.attempts[0]?.wire).toBeUndefined();
		expect(loopback.requests).toHaveLength(1);
		expect(leases).toHaveLength(1);
		expect(leases[0]?.events.map(event => event.type)).toEqual(["beginSend", "observeResponse", "observeChunk", "settle"]);
		expect(leases[0]?.settled).toEqual([{ type: "response-ended", status: 200 }]);
	});

	test("the gate is shown the request without credentials in its url or headers, and the caller still reads the unaltered response", async () => {
		const sent: string[] = [];
		const base: FetchImpl = async input => {
			sent.push(String(input));
			return new Response("caller-visible body", { status: 200 });
		};
		const fetch = gateFetch(MODEL_REF, "chat", base);
		const lease = recordingLease();
		gate.setHandler(async () => ({ type: "allow", lease: lease.lease }));

		const response = await fetch("https://user:hunter2@example.invalid/v1/x?api_key=abc&q=1#frag", {
			method: "post",
			headers: {
				authorization: "Bearer hunter2",
				"x-api-key": "hunter2",
				"x-goog-api-key": "hunter2",
				cookie: "session=hunter2",
				"content-type": "application/json",
				"x-keep": "1",
			},
			body: '{"a":1}',
		});
		const consumed = await response.text();
		await lease.firstSettle;

		const wire = wireOf(gate.attempts[0]!);
		expect(wire.method).toBe("POST");
		expect(wire.url).toBe("https://example.invalid/v1/x?q=1");
		expect(wire.headers).toEqual({ "content-type": "application/json", "x-keep": "1" });
		expect(wire.bodyBytes).toBe(7);
		expect(new TextDecoder().decode(await wire.readBody())).toBe('{"a":1}');
		// The caller's request is untouched by the redaction.
		expect(sent).toEqual(["https://user:hunter2@example.invalid/v1/x?api_key=abc&q=1#frag"]);
		expect(consumed).toBe("caller-visible body");
		expect(Buffer.from(lease.observedBytes()).toString()).toBe(consumed);
		expect(lease.settled).toEqual([{ type: "response-ended", status: 200 }]);
	});
});

const CUSTOM_API = "loopback-custom-transport";
const CUSTOM_SOURCE = "model-request-transport-hook-test";

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function customAnswer(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "custom transport answer" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: 1,
		stopReason: "stop",
		usage: emptyUsage(),
	};
}

function uninstrumentedModel(api: string, provider: string): Model<Api> {
	return buildModel({
		id: "loopback-model",
		name: "Loopback model",
		api,
		provider,
		baseUrl: "http://127.0.0.1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10_000,
		maxTokens: 1_000,
	});
}

describe("transports the core cannot instrument", () => {
	let streamFunctionCalls = 0;

	beforeEach(() => {
		streamFunctionCalls = 0;
		registerCustomApi(
			CUSTOM_API,
			model => {
				streamFunctionCalls += 1;
				const events = new AssistantMessageEventStream();
				const message = customAnswer(model);
				events.push({ type: "start", partial: message });
				events.push({ type: "done", reason: "stop", message });
				return events;
			},
			CUSTOM_SOURCE,
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setBedrockProviderModule(bedrockProvider);
		setCursorProviderModule(cursorProvider);
		unregisterCustomApis(CUSTOM_SOURCE);
	});

	/** A transport entry that counts how often it is started and answers at once, in place of the provider's own. */
	function countingTransport(): { readonly start: (model: Model<Api>) => AssistantMessageEventStream; readonly started: () => number } {
		let count = 0;
		return {
			start(model) {
				count += 1;
				const events = new AssistantMessageEventStream();
				const message = customAnswer(model);
				events.push({ type: "start", partial: message });
				events.push({ type: "done", reason: "stop", message });
				return events;
			},
			started: () => count,
		};
	}

	interface Target {
		readonly name: string;
		readonly model: () => Model<Api>;
		/** Install the probe; the returned function reports how many times the real transport entry was started. */
		readonly probe: () => () => number;
	}

	const targets: readonly Target[] = [
		{
			name: "a registered custom API",
			model: () => uninstrumentedModel(CUSTOM_API, "loopback-provider"),
			probe: () => () => streamFunctionCalls,
		},
		{
			name: "bedrock-converse-stream",
			model: () => uninstrumentedModel("bedrock-converse-stream", "amazon-bedrock"),
			probe: () => {
				const counting = countingTransport();
				setBedrockProviderModule({ streamBedrock: counting.start });
				return counting.started;
			},
		},
		{
			name: "cursor-agent",
			model: () => uninstrumentedModel("cursor-agent", "cursor"),
			probe: () => {
				const counting = countingTransport();
				setCursorProviderModule({ streamCursor: counting.start });
				return counting.started;
			},
		},
		{
			name: "gitlab-duo-agent",
			model: () => uninstrumentedModel("gitlab-duo-agent", "gitlab-duo-test"),
			probe: () => {
				const counting = countingTransport();
				vi.spyOn(gitlabWorkflowProvider, "streamGitLabDuoWorkflow").mockImplementation(counting.start);
				return counting.started;
			},
		},
	];

	for (const target of targets) {
		describe(target.name, () => {
			for (const entry of ENTRIES) {
				test(`${entry.name}: the gate is asked once with no wire, and a deny keeps the transport from being started`, async () => {
					const model = target.model();
					const started = target.probe();
					gate.setHandler(async () => ({ type: "deny", code: "loopback-denied", message: "no transport for you" }));

					const result = await entry.run(model, helloContext(), { apiKey: SECRET });

					expect(gate.attempts).toHaveLength(1);
					const attempt = gate.attempts[0]!;
					expect(attempt.wire).toBeUndefined();
					expect(attempt.kind).toBe("chat");
					expect(attempt.reason).toBe("first");
					expect(attempt.model).toEqual(modelRefOf(model));
					expect(isDenied(result)).toBe(true);
					expect(errorTextOf(result)).toContain("no transport for you");
					expect(started()).toBe(0);
				});

				test(`${entry.name}: an allow with a lease is refused as transport-unsupported and the lease is released as not-sent exactly once`, async () => {
					const model = target.model();
					const started = target.probe();
					const leases = allowEachAttempt();

					const result = await entry.run(model, helloContext(), { apiKey: SECRET });
					await afterSettling();

					expect(gate.attempts).toHaveLength(1);
					expect(gate.attempts[0]?.wire).toBeUndefined();
					expect(isDenied(result)).toBe(true);
					expect(started()).toBe(0);
					expect(leases).toHaveLength(1);
					expect(leases[0]?.settled).toEqual([{ type: "not-sent", aborted: false }]);
					expect(leases[0]?.events.map(event => event.type)).toEqual(["settle"]);
				});
			}
		});
	}

	for (const target of targets) {
		for (const entry of ENTRIES) {
			test(`${target.name}, ${entry.name}: a pass lets the transport start once for the one authorized attempt`, async () => {
				const model = target.model();
				const started = target.probe();

				const result = await entry.run(model, helloContext(), { apiKey: SECRET });

				expect(textOf(result.message)).toBe("custom transport answer");
				expect(started()).toBe(1);
				expect(gate.attempts).toHaveLength(1);
				expect(gate.attempts[0]?.wire).toBeUndefined();
				expect(gate.attempts[0]?.model).toEqual(modelRefOf(model));
			});
		}
	}
});

interface ProcessResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

const PROCESS_FIXTURE = `${import.meta.dir}/fixtures/model-request-transport-process.ts`;

async function runScenario(scenario: string): Promise<Record<string, unknown>> {
	const child = Bun.spawn([process.execPath, PROCESS_FIXTURE, scenario], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode]: [string, string, number] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	const result: ProcessResult = { exitCode, stdout, stderr };
	if (result.exitCode !== 0) throw new Error(`fixture exited ${result.exitCode}: ${result.stderr}`);
	const parsed: unknown = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "");
	if (typeof parsed !== "object" || parsed === null) throw new Error(`unexpected fixture output: ${result.stdout}`);
	return Object.fromEntries(Object.entries(parsed));
}

describe("process-wide gate state", () => {
	test("with no gate registered every entry reaches the loopback exactly once per request and returns the provider's answer unchanged", async () => {
		const result = await runScenario("unregistered");

		expect(result.registered).toBe(false);
		const expected: Record<string, unknown> = {};
		for (const api of APIS) {
			for (const entry of ENTRIES) {
				expected[`${api}/${entry.name}`] = { requests: 1, stopReason: "stop", text: REPLY_TEXT };
			}
		}
		expect(result.outcomes).toEqual(expected);
	});

	test("a gate that never answers within authorizeTimeoutMs denies with gate-error and nothing reaches the loopback", async () => {
		const result = await runScenario("authorize-timeout");

		const expected: Record<string, unknown> = {};
		for (const api of APIS) {
			for (const entry of ENTRIES) {
				expected[`${api}/${entry.name}`] = { requests: 0, denied: true, asked: 1 };
			}
		}
		expect(result.outcomes).toEqual(expected);
		expect(result.timeoutMessage).toMatch(/did not answer within the configured timeout/);
	});
});
