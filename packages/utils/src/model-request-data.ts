/** Canonical data shared by request execution and journal persistence. */
/** Purpose declared by the call site. The core never interprets it. */
export type ModelRequestPurpose =
	| "main"
	| "subagent"
	| "advisor"
	| "side-channel"
	| "compaction"
	| "branch-summary"
	| "handoff"
	| "judge"
	| "memory"
	| "title"
	| "auto-repair"
	| "commit"
	| "annotate"
	| "speech-enhance"
	| "cache-warm"
	| "embedding"
	| "other";

export interface ModelRequestAgent {
	readonly id: string;
	readonly kind: "main" | "sub";
	readonly name: string;
	readonly depth: number;
	readonly parentId?: string;
}

export interface ModelRequestScope {
	/**
	 * Id of the root session the user started or resumed. A root is its own root; children receive it
	 * explicitly from the core. Never inferred from a `parentSession` header. `undefined` means a child
	 * was created without an explicit root.
	 */
	readonly rootSessionId: string | undefined;
	/** Session that issued the request. */
	readonly sessionId: string;
	readonly agent: ModelRequestAgent;
	readonly purpose: ModelRequestPurpose;
}
export interface ModelRequestModelRef {
	readonly provider: string;
	readonly id: string;
	readonly api: string;
	readonly baseUrl?: string;
}
export type ModelRequestOutcome =
	| { readonly type: "not-sent"; readonly aborted: boolean }
	| {
			readonly type: "request-failed";
			readonly sent: "no" | "maybe";
			readonly aborted: boolean;
			readonly transportClosed: boolean;
	  }
	| { readonly type: "response-ended"; readonly status: number }
	| {
			readonly type: "response-failed";
			readonly status?: number;
			readonly aborted: boolean;
			readonly transportClosed: boolean;
	  };
