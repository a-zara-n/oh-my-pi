import { describe, expect, it } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";

interface Observation {
	where: string;
	scope: string | undefined;
}

const RUN_SCOPE = "run-scope";
const probeSchema = type({ msg: "string" });

function createProbe(
	store: AsyncLocalStorage<string>,
	observed: Observation[],
): AgentTool<typeof probeSchema, { msg: string }> {
	return {
		name: "probe",
		label: "Probe",
		description: "Records the scope it runs in",
		parameters: probeSchema,
		async execute(_toolCallId, params) {
			observed.push({ where: "tool", scope: store.getStore() });
			return { content: [{ type: "text", text: "probed" }], details: params };
		},
	};
}

/**
 * `runInScope` lets a host (an `AsyncLocalStorage` context, for instance) own everything a run does. A host that
 * installs a context there must see it in the provider call, in tool execution and in subscriber callbacks, or a
 * request made from any of them runs outside the context.
 */
describe("Agent runInScope", () => {
	it("runs the provider call, tool execution and subscribers of a prompt inside the scope", async () => {
		const store = new AsyncLocalStorage<string>();
		const observed: Observation[] = [];
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", name: "probe", arguments: { msg: "x" } }] },
				{ content: ["done"] },
			],
		});
		const agent = new Agent({
			initialState: { model: mock.model, tools: [createProbe(store, observed)] },
			streamFn: (model, context, options) => {
				observed.push({ where: "stream", scope: store.getStore() });
				return mock.stream(model, context, options);
			},
			runInScope: fn => store.run(RUN_SCOPE, fn),
		});
		agent.subscribe(event => {
			observed.push({ where: event.type, scope: store.getStore() });
		});

		await agent.prompt("go");

		expect(observed.filter(entry => entry.where === "stream")).toHaveLength(2);
		expect(observed.filter(entry => entry.where === "tool")).toHaveLength(1);
		expect(observed.some(entry => entry.where === "agent_end")).toBe(true);
		expect(observed.filter(entry => entry.scope !== RUN_SCOPE)).toEqual([]);
		// The scope belongs to the run, not to the caller that awaited it.
		expect(store.getStore()).toBeUndefined();
	});

	it("runs a continuation inside the scope, including the queue dequeue hooks before the first turn", async () => {
		const store = new AsyncLocalStorage<string>();
		const observed: Observation[] = [];
		const mock = createMockModel({ responses: [{ content: ["Answer"] }] });
		const agent = new Agent({
			streamFn: (model, context, options) => {
				observed.push({ where: "stream", scope: store.getStore() });
				return mock.stream(model, context, options);
			},
			runInScope: fn => store.run(RUN_SCOPE, fn),
		});
		agent.subscribe(event => {
			observed.push({ where: event.type, scope: store.getStore() });
		});
		agent.addBeforeQueuedMessageDequeueHook(() => {
			observed.push({ where: "dequeue-hook", scope: store.getStore() });
		});
		agent.steer({ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() });

		await agent.continue();

		expect(observed.filter(entry => entry.where === "stream")).toHaveLength(1);
		expect(observed.some(entry => entry.where === "dequeue-hook")).toBe(true);
		expect(observed.filter(entry => entry.scope !== RUN_SCOPE)).toEqual([]);
	});
});
