/**
 * A legacy pi extension cannot name its host session when it calls `createAgentSession()`, yet the session it
 * creates is a child of the session whose handler is running. The shim derives the hand-over from the context the
 * extension code runs in, so such a session is never a free root and never a silently root-less child.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { runWithModelRequestExecution } from "@oh-my-pi/pi-ai/model-request-execution";
import { createAgentSession as legacyCreateAgentSession } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { createSessionModelRequestExecution } from "@oh-my-pi/pi-coding-agent/session/model-request-context";

afterEach(() => {
	vi.restoreAllMocks();
});

function captureSdkCall(): { options: () => CreateAgentSessionOptions | undefined } {
	let captured: CreateAgentSessionOptions | undefined;
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async (options?: CreateAgentSessionOptions) => {
		captured = options;
		return { session: {} as never } as unknown as CreateAgentSessionResult;
	});
	return { options: () => captured };
}

function hostExecution(sessionId: string) {
	return createSessionModelRequestExecution({
		getSessionId: () => sessionId,
		agent: { id: "Main", kind: "main", name: "main", depth: 0 },
		root: { kind: "self" },
	});
}

describe("legacy createAgentSession model-request root", () => {
	it("hands the running host session's root to the session it creates", async () => {
		const sdkCall = captureSdkCall();

		const parent = hostExecution("legacy-host-session");
		await runWithModelRequestExecution(parent, () => legacyCreateAgentSession({}));

		expect(sdkCall.options()?.modelRequestRoot).toMatchObject({
			kind: "child",
			rootSessionId: "legacy-host-session",
		});
		expect(sdkCall.options()?.modelRequestRoot?.parentExecution).toBe(parent);
		expect(Object.isFrozen(sdkCall.options()?.modelRequestRoot)).toBe(true);
	});

	it("keeps an explicit hand-over instead of deriving one", async () => {
		const sdkCall = captureSdkCall();

		await runWithModelRequestExecution(hostExecution("legacy-host-session"), () =>
			legacyCreateAgentSession({ modelRequestRoot: { kind: "child", rootSessionId: "explicit-root" } }),
		);

		expect(sdkCall.options()?.modelRequestRoot).toEqual({ kind: "child", rootSessionId: "explicit-root" });
	});

	it("leaves a session created outside any session context as a user-started root", async () => {
		const sdkCall = captureSdkCall();

		await legacyCreateAgentSession({});

		expect(sdkCall.options()?.modelRequestRoot).toBeUndefined();
	});
});
