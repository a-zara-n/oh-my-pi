# Model request gate

A generic, additive hook that lets one registered owner decide whether an outbound model request may leave the
process. The core does not know what the owner decides on. With no gate registered, or a gate that answers `pass`,
every request path behaves exactly as it did before.

This document covers the gate API, the core-owned execution context that identifies who is asking, the denial's
non-retry contract, the per-attempt hook that asks the gate before each wire attempt, and the coverage inventory.

## Public API (`@oh-my-pi/pi-ai`, `packages/ai/src/model-request-gate.ts`)

| Export | Purpose |
| --- | --- |
| `ModelRequestGate` | `authorize(attempt) => Promise<ModelRequestDecision>` where a decision is `pass`, `allow` (with a lease), or `deny` (code + message). |
| `registerModelRequestGate(owner, gate, options?)` | Registers the process's gate. Re-registering the same gate under the same owner with the same options is a no-op; anything else throws. There is **no unregister**: a gate cannot be removed midway to let later requests through unchecked. |
| `ModelRequestGateOptions.authorizeTimeoutMs` | Optional positive safe integer, at most 2,147,483,647 ms (the longest delay a platform timer honors; larger values are rejected, not clamped). If the gate has not answered by then, the request is denied with `gate-error`. There is no default: without it the core waits until the request's own signal aborts. In neither case does any I/O start. |
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
`@oh-my-pi/pi-ai` barrel, and no public option or request argument accepts an origin, scope or root. That is the whole
extent of the guarantee: pi-ai's package `./*` export map still makes `model-request-execution` and
`model-request-runtime` importable by any code in the process (an extension included), and such code can mint contexts
or mark the process standalone. What is closed is self-declaration through the request API and fabricated context
objects (a context is accepted only if this runtime minted it); hostile in-process code is outside this boundary and
is limited by the tool allow-list, not by this layer. The runtime instance is shared through `globalThis`, so a second
copy of the module in the same process cannot hold a different latch.

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

## Per-attempt hook

A wire attempt is one HTTP request (or connection). With a gate registered, every call of the fetch the core controls is
authorized on its own: `transportFetch` for everything that goes through `stream` / `streamSimple` / `complete` /
`completeSimple`, `gateFetch` for the callers that build their own fetch (the native judge, remote compaction). With no
gate registered those calls go straight to the underlying fetch, unchanged.

For each attempt the core: (1) builds the attempt (`origin` and `scope` from the execution context, never from the
caller; `kind`; the model's provider/id/api/baseUrl) and a credential-free `wire` (method, url without userinfo or
credential-looking query parameters, headers without credential-looking names, `bodyBytes`, and an in-memory
`readBody()`); (2) awaits `gate.authorize`; a denial, a failing or malformed gate, or a gate that does not answer in time
is a `ModelRequestDeniedError` and nothing is sent; (3) on `allow`, calls `lease.beginSend()` synchronously immediately
before the first I/O; (4) hands the response head to `observeResponse` and every body chunk to `observeChunk` while the
body passes to the caller unaltered; (5) settles the lease exactly once (`response-ended`, `response-failed`,
`request-failed`, or `not-sent`), including on a caller abort or when the caller stops reading. A consumer that stops
reading at the protocol's terminal event, a moment before the transport reports the end of the body, is still settled as
`response-ended` if that read was already in flight (bounded to one macrotask). A gate error in `observeResponse`,
`observeChunk` or `settle` is logged and never replaces the request's own result. The body is only ever held in memory.

`wire` is `undefined` when the body cannot be read without consuming or sending it (a stream, `FormData`, a `Request`
that carries its own body). The core only reports that; it still asks the gate and sends what the gate permits (`pass`,
or `allow` with a lease), so refusing an unreadable body is the gate's decision (`deny`, conventionally
`transport-unsupported`). A gate whose `beginSend()` throws is a terminal `gate-error`: nothing is sent, the lease is
settled as `not-sent`, and no retry layer replays it.

The attempt's `model` is the model the request is addressed to, after the provider definition prepared it (a gateway
route may rewrite the api and base URL), and its `baseUrl` is redacted like the wire url when it carries a credential.
The remote summarizer endpoint is named as the base URL of its attempt.

### Requests that are not model requests

A provider receives one gated `options.fetch` for its inference request, but also needs a fetch for requests that are
not model requests: OAuth and token exchange, credential and metadata lookups (Google ADC, GitLab direct access, Devin
auth metadata, AWS STS/SSO/IMDS), version probes. They must not use it, or the gate would be shown credential request
bodies and responses, count them as attempts, and a later real attempt would be labelled a retry of them. They use
`auxiliaryFetch(options.fetch)`, which returns the same transport (proxy, CA, User-Agent, request recording) without
the gate; a fetch that is not gated is returned unchanged. A gate denial raised by a lookup is never converted into a
missing credential.

### Which kind of attempt

Each attempt carries a `requestId` (one `stream` / `complete` / judgment call), a core-generated `attemptId`, a `reason`
and `retryOf` (the previous attempt's id when it is a re-attempt):

| reason | when |
| --- | --- |
| `first` | the first attempt of a request, and any request that merely follows another one |
| `provider-retry` | a second wire attempt inside the same logical request (a provider re-sending) |
| `auth-rotation` | the credential was rotated and the request re-sent (`streamSimple` loop, `withAuth`, `withOAuthAccess`, turn-level switch) |
| `thinking-loop-retry` | `complete` / `completeSimple` re-sampled a stalled thinking loop |
| `oneshot-retry` | `retryTransientCompletion` re-ran the request |
| `turn-retry` | the session's automatic retry of a turn (also malformed-call, stall and empty-stop continuations) |
| `model-fallback` | the next model of a fallback walk (turn recovery, compaction candidates, completion/title/commit/memory walks) |
| `judge-candidate`, `judge-attempt` | the next judge-role candidate; a judge's own re-attempt (native retry, a further prompted turn) |
| `replay` | the cache warmer's replay of the last request |

The link is a lineage (the logical request) and a retry chain (consecutive attempts, possibly across logical requests);
both are internal (`packages/ai/src/model-request-lineage.ts`) and a retry loop declares its reason with
`markNextModelRequestAttempt` / `runInModelRequestRetryChain`. Nothing there can influence `origin` or `scope`. A chain
nested in another joins it, so a fallback walk's pending reason survives until the first inner attempt consumes it.

### Transports the core cannot account for

A registered extension provider, and the APIs that do not go through a fetch the core controls (`bedrock-converse-stream`,
`cursor-agent`, `apple-foundation-models`, `factory-droid-agent`, `gitlab-duo-agent`; including the direct
`streamSimple` branch of `gitlab-duo-agent`), cannot be driven through a lease.
The gate is asked once with `wire: undefined` and must answer `pass` or `deny`; an `allow` is released as `not-sent`
and refused with `transport-unsupported` (a gate cannot permit what the core cannot account for). An on-device
transport is exempt: `markModelRequestLocalStream(fn)` binds the exemption to that function (the local-inference
transport), so registering another function under the same API name does not inherit it. It is the function that is
dispatched that must be declared: a local `streamSimple` next to a separately supplied `stream` is exempt for
`streamSimple` only. The `openai-codex` WebSocket path (also taken by the v2 streaming compaction) does not call any
hook yet.

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

`coverage.complete` is true only when the context self-check passed and **no** site is uncovered. A site is moved to
`context-inherited` only when a request from that site has been sent through the real code path to a loopback fake
provider and the gate saw exactly the attempts the provider received (`packages/coding-agent/test/model-request-site-sends.test.ts`,
the ai transport tests and the judge/recovery tests); the core does not check this, it is the operating rule for editing the
table. A site only partly verified stays uncovered with the unverified part in its reason (S-12 until the v2 streaming
compaction, whose openai-codex branch sends over a WebSocket, is verified; S-14; S-17). The sites still uncovered are
listed in the table with the reason, and the table is not complete.
`inventoryVersion` is the hex SHA-256 over every site in table order, each contributing
`id`, `location`, `status`, `contextPropagation` and `reason` (NUL-separated, one line per site). Editing any of those
fields of any site, or adding/removing/reordering a site, changes it; `note` text outside `reason` and the table's
comments do not. A site's `status` is derived, so flipping a site's hook changes the version too.

Context-loss boundaries (Worker hosts, child processes, native callbacks) are judged by static search only: the Python
kernel spawn and probe spawns issue no model request, and the Worker entry modules import no model entry, but their
transitive imports and native callback chains were not checked, so they stay in the inventory as `unverified`
(uncovered) until proven. The eval JS worker, the browser tab and computer workers, and the Python loopback bridge do
reach the host and are re-bound explicitly (S-37, S-38).

## Scope of this layer

Included: the API, latch, context and origin/scope derivation, root hand-over, purposes, deferred-job binding,
standalone classification, denial classification and non-retry, the per-attempt hook for fetch-based requests (chat,
judgments, remote compaction), the retry/fallback reasons, refusal of transports whose request cannot be read or
accounted for, and the inventory.

Not included: proof that the direct provider paths (S-27..S-36: `providers/*` imported directly, the legacy shim's
`anthropicMessagesApi().stream`, Bedrock/Cursor/pi-native/devin/factory-droid transports, image and other kinds), the
`openai-codex` WebSocket, memory/mnemopi/sharpshooter jobs, changelog and conventional-commit generation, the
Worker/native context boundaries and the entry handlers go through the hook; and the static check that fails when a new
request path is missing from the inventory. They stay `uncovered`.

## Tests

`packages/ai/test/model-request-gate*.test.ts` (runtime semantics, coverage rule, process-wide behavior in a child
process), `model-request-denial-terminal.test.ts`, `packages/agent/test/agent-run-in-scope.test.ts`, and
`packages/coding-agent/test/` `model-request-context-session`, `task/model-request-root-handover`,
`eval/model-request-bridge-context`, `tools/computer-model-request-context`, `extensibility/extension-model-request-context`,
`extensibility/legacy-pi-session-model-request-root`, `cli/standalone-commands`, `judgment-chain-denial`,
`turn-recovery-denial`, `model-request-site-sends`, `model-request-judge-attempts`, `model-request-recovery-attempts`,
`model-request-fallback-walk`, `model-request-local-inference`; in packages/ai/test `model-request-transport-hook`,
`model-request-attempt-contract`, `model-request-local-exemption`, `model-request-auxiliary-fetch`,
`model-request-retry-reasons` and `packages/agent/test/compaction-remote-gate`. A gate registration cannot be undone, so tests share one fixture gate
(`packages/ai/test/helpers/model-request-gate-fixture.ts`) that answers `pass` unless a test sets a handler. The
browser tab Worker's tool-call binding has no test: its dispatch is only reachable through a real browser.
