import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
// @ts-expect-error AI lifetime ownership is not a public package subpath.
import type * as AiInternal from "@oh-my-pi/pi-ai/internal/journal-outer-work";
// @ts-expect-error Explicit TypeScript suffix must not expose AI internals.
import type * as AiInternalTs from "@oh-my-pi/pi-ai/internal/journal-outer-work.ts";
// @ts-expect-error Explicit JavaScript suffix must not expose AI internals.
import type * as AiInternalJs from "@oh-my-pi/pi-ai/internal/journal-outer-work.js";
// @ts-expect-error SDK lifetime ownership is not a public package subpath.
import type * as SdkInternal from "@oh-my-pi/pi-coding-agent/session/internal/outer-work";
// @ts-expect-error Explicit TypeScript suffix must not expose SDK internals.
import type * as SdkInternalTs from "@oh-my-pi/pi-coding-agent/session/internal/outer-work.ts";
// @ts-expect-error Explicit JavaScript suffix must not expose SDK internals.
import type * as SdkInternalJs from "@oh-my-pi/pi-coding-agent/session/internal/outer-work.js";
declare const session: AgentSession;
// @ts-expect-error Arbitrary callback registration must not extend AgentSession's public API.
session.runJournalOuterWork;
// @ts-expect-error Arbitrary Promise registration must not extend AgentSession's public API.
session.trackJournalOuterWork;
export type DeniedLifetimeImports = [
	typeof AiInternal,
	typeof AiInternalTs,
	typeof AiInternalJs,
	typeof SdkInternal,
	typeof SdkInternalTs,
	typeof SdkInternalJs,
];
