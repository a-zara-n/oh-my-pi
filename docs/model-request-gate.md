# Model request gate

A generic, additive hook that lets one registered owner decide whether an outbound model request may leave the
process. The core does not know what the owner decides on. With no gate registered, or a gate that answers `pass`,
every request path behaves exactly as it did before.

This document covers the gate API, the core-owned execution context that identifies who is asking, the denial's
non-retry contract, and the coverage inventory. The per-attempt transport/judge hook that calls the gate on each wire
attempt is a separate layer (see [Scope of this layer](#scope-of-this-layer)).

## Public API (`@oh-my-pi/pi-ai`, `packages/ai/src/model-request-gate.ts`)

| Export | Purpose |
| --- | --- |
| `ModelRequestGate` | `authorize(attempt) => Promise<ModelRequestDecision>` where a decision is `pass`, `allow` (with a lease), or `deny` (code + message). |
| `registerModelRequestGate(owner, gate, options?)` | Registers the process's gate. Re-registering the same gate under the same owner with the same options is a no-op; anything else throws. There is **no unregister**: a gate cannot be removed midway to let later requests through unchecked. |
| `ModelRequestGateOptions.authorizeTimeoutMs` | Optional positive integer. If the gate has not answered by then, the request is denied with `gate-error`. There is no default: without it the core waits until the request's own signal aborts. In neither case does any I/O start. |
| `getModelRequestGateInfo()` | `{ apiVersion: 1, registered, coverage }`. `coverage` lists every inventory site with its status, how the execution context reaches it, `complete`, the context self-check result and an `inventoryVersion` digest. |
| `verifyModelRequestContext()` | Runs (or awaits) the self-check of the execution-context mechanism. |
| `ModelRequestDeniedError` | `code: string`, `retryable: false`. |

A gate that throws, rejects, returns something that is not a `pass`/`allow`/`deny` decision, returns an `allow`
without a usable lease, or never answers within `authorizeTimeoutMs`, is a `gate-error` denial. A lease granted after
the caller already stopped waiting (timeout or abort) is released as `not-sent`, exactly once.

## Who is asking: core-owned execution context

`ModelRequestAttempt.origin` and `.scope` are never supplied by a caller. The core derives them from its own
`AsyncLocalStorage` context (`packages/ai/src/model-request-runtime.ts`), whose values are registered in a private
`WeakSet`; an object the core did not mint is not a context and is refused.

| Origin | When |
| --- | --- |
| `session` | A valid core execution context is active. `scope` carries `rootSessionId`, `sessionId`, `agent` and `purpose`. |
| `standalone` | No context, and the process was marked a session-less command at its entry (`markModelRequestProcessStandalone`). A marked process can never create a session, and a process that already has a session cannot be marked. |
| `unclassified` | Neither. |

`rootSessionId`:

- A session the user started or resumed is its own root, **re-evaluated on every request** from
  `sessionManager.getSessionId()`, so `/new` never bills the previous root.
- A child session receives its spawner's root **explicitly** (`CreateAgentSessionOptions.modelRequestRoot`, obtained from
  `AgentSession.childModelRequestRoot()` / `ToolSession.childModelRequestRoot()`). It is never inferred from a
  `parentSession` header or an agent id chain.
- A session created while another session's context is active, without an explicit hand-over, is a child with
  `rootSessionId: undefined`. The gap is visible to the gate; it is not turned into a fresh root.

The execution module (`@oh-my-pi/pi-ai/model-request-execution`) is internal and deliberately absent from the
`@oh-my-pi/pi-ai` barrel. No public option accepts an origin, scope or root. The runtime instance is shared through
`globalThis`, so a second copy of the module in the same process cannot hold a different latch.

### Where the context is installed

| Place | How |
| --- | --- |
| `createAgentSession` | Mints the session execution once (session id read lazily from the session manager). |
| Agent runs (`packages/agent` `AgentOptions.runInScope`) | The whole run — turns, tool executions, retries, subscriber callbacks — runs inside it. |
| Session stream functions | Main, cache-warm, side-channel, compaction, handoff, branch-summary, advisor and memory streams are decorated with the session execution and a purpose. |
| `AgentSession` methods that call a model outside the loop | Title generation, image description, memory/auto-learn/flush paths run in the session context with their purpose. |
| Extension runner | Every handler, extension tool, command, shortcut, and `ctx.setTimeout`/`ctx.setInterval` callback runs inside the session's context (so extension code calling pi-ai directly, including through the legacy shim, inherits it). |
| Child sessions | Task executor, structured subagents, eval `agent()`, `/tan`, agents hub, security scan, vibe workers, persisted revive pass the host's root explicitly. |
| Deferred work | Background jobs, mnemopi/sharpshooter queues and listeners, and the tool calls that the eval JS Worker, the browser tab Worker, the computer Worker and the Python eval bridge make back into the host are re-bound to the originating session context (`bindModelRequestExecution`) because the scope has exited, or never reached the Worker, by the time they run. |

AsyncLocalStorage follows awaits, timers and microtasks created inside the scope. EventEmitter listeners run in the
**emitter's** context, and Worker, child process and native callbacks carry nothing; those paths are bound
explicitly or listed as uncovered.

### Session-less commands

`packages/coding-agent/src/cli/standalone-commands.ts` classifies every registered CLI command as session-less or
session-capable; a unit test fails when a command is unclassified. Only the real process entry marks the process, so
importers of `runCli` can still create sessions. A command that is marked but creates a session fails loudly.

## Denial is terminal

A denial carries `AIError.Flag.ModelRequestDenied` (an exclusive classification: `AIError.classify` returns only that
flag when a denial is in the cause chain or on `message.errorId`). Retry, credential rotation, provider backoff,
thinking-loop retry, oneshot retry, turn auto-retry, model fallback, judge-candidate fallback and compaction fallback
all stop on it. The decision reads the structured flag only, never the denial text, so a gate message that mentions a
usage limit or a status code cannot trigger rotation. `AIError.isModelRequestDenied(errorOrMessage)` is the shared
check; `packages/utils` (which cannot import pi-ai) uses the structural `retryable === false`.

## Coverage inventory

`packages/ai/src/model-request-coverage.ts` is a static table of every path that can send a model request. A site is:

- `gated`: the site calls the gate itself;
- `context-inherited`: its requests reach a shared per-attempt hook with the context intact;
- `uncovered`: anything else, including every site whose context is not carried or not verified.

`coverage.complete` is true only when the context self-check passed and **no** site is uncovered. In this layer no
per-attempt hook exists yet, so the shipped table is not complete, and a consumer must not treat it as such.
`inventoryVersion` is a SHA-256 over the table and changes with any edit.

Context-loss boundaries (Worker hosts, child processes, native callbacks) are judged by static search only: the Python
kernel spawn and probe spawns issue no model request, and the Worker entry modules import no model entry, but their
transitive imports and native callback chains were not checked, so they stay in the inventory as `unverified`
(uncovered) until proven. The eval JS worker, the browser tab and computer workers, and the Python loopback bridge do
reach the host and are re-bound explicitly (S-37, S-38).

## Scope of this layer

Included: the API, latch, context and origin/scope derivation, root hand-over, purposes, deferred-job binding,
standalone classification, denial classification and non-retry across the retry/fallback sites, and the inventory.

Not included (next layers): the per-attempt hook in `transportFetch` and the judges (`authorize → beginSend → observe
→ settle`, credential-free wire, per-retry-kind `reason`/`attemptId`), refusing transports whose body cannot be read,
and the uncovered-path proofs plus the static check that fails when a new request path is not in the inventory. Until
those land, `authorizeModelRequest` is the call a transport makes and no shipped transport calls it.

## Tests

`packages/ai/test/model-request-gate*.test.ts` (runtime semantics, coverage rule, process-wide behavior in a child
process), `model-request-denial-terminal.test.ts`, `packages/agent/test/agent-run-in-scope.test.ts`, and
`packages/coding-agent/test/` `model-request-context-session`, `task/model-request-root-handover`,
`eval/model-request-bridge-context`, `tools/computer-model-request-context`, `extensibility/extension-model-request-context`,
`extensibility/legacy-pi-session-model-request-root`, `cli/standalone-commands`, `judgment-chain-denial`,
`turn-recovery-denial`. A gate registration cannot be undone, so tests share one fixture gate
(`packages/ai/test/helpers/model-request-gate-fixture.ts`) that answers `pass` unless a test sets a handler. The
browser tab Worker's tool-call binding has no test: its dispatch is only reachable through a real browser.
