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
caller; `kind`; the model's provider/id/api/baseUrl) and a `wire` with the credentials the core can recognise by name removed (method, url without userinfo or
credential-looking query parameters, headers without credential-looking names, `bodyBytes`, and an in-memory
`readBody()`; the body is not redacted, and a provider whose own protocol puts a credential in the request body, as
Devin does in its message metadata, shows it there to a gate that decodes the body); (2) awaits `gate.authorize`; a denial, a failing or malformed gate, or a gate that does not answer in time
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

A provider receives one gated `options.fetch` for its model request, but also needs a fetch for requests around it. Only
a request that **carries no prompt or user content and runs no model** may bypass the gate: OAuth and token exchange,
credential and identity lookups, account and model-catalog metadata, version probes (Google ADC, GitLab direct access,
Devin `GetUserJwt`, AWS STS/SSO/IMDS, the Antigravity version manifest). Such a request must not use the gated fetch, or
the gate would be shown credential request bodies and responses, count them as attempts, and a later real attempt would
be labelled a retry of them. It uses `auxiliaryFetch(options.fetch)`, which returns the same transport (proxy, CA,
User-Agent, request recording) without the gate; a fetch that is not gated is returned unchanged. A gate denial raised
by a lookup is never converted into a missing credential.

Anything that sends the user's prompt, or makes the provider run a model on it, is a model request and stays on the
gated fetch, as an attempt of its own. Devin's router assignment (`AssignModel`) is one: it scores the current user turn
on the provider's side before the chat message is sent, so it is authorized first (`runAsIndependentModelRequest` gives
it its own `requestId` and retry chain, so it is a `first` attempt and the chat attempt that follows is not labelled a
retry of it), and a refusal sends nothing of the turn. The setup calls of a transport the core cannot account for (the
GitLab Duo workflow's REST calls, one of which carries the goal) are not asked again: the gate was asked once for that
whole transport before any of them (see below).

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

### Audit startup builtin identity (D-37)

The isolated `scripts/audit-library-bootstrap.ts` imports the dependency-free
`utils/model-request-builtin-fetch` leaf before the application graph. That leaf
captures the actual `globalThis.fetch` reference once. Its non-replaceable
process identity distinguishes the canonical module from a separately evaluated
copy; required fetch wrappers reject a custom/queued sender or a later global
replacement before invoking that sender. Function source, names, URLs, caller
booleans and callback registration are not transport evidence. The leaf itself
does not select SQLite, load a provider, or change ordinary untracked custom-fetch
and Cowork behavior.

For a required transport, request-debug snapshot/file preparation is awaited
before entering `gatedSend`, and response-debug wrapping stays after the returned
response. The ordinary untracked sender retains its existing debug/Cowork path.

This requires trusted startup to run before extensions, configuration or other
untrusted JavaScript. It is not an in-process JavaScript sandbox and does not
prove that a builtin call starts DNS, TLS or socket writes synchronously.
**The capture/identity check alone does not enable required sending.** Required
sends remain `transport-unsupported` until the journal leaf supplies the approved
one-use admission and actual synchronous short-root release contract.

Parent verification uses the real builtin, not a fake-fetch wiring test:

1. Run `bun test packages/ai/test/model-request-builtin-fetch.test.ts` and the
   existing transport-hook suite. The capture suite covers real loopback I/O,
   queued custom-sender rejection, a replacement getter that must not execute,
   and a separately evaluated physical module copy.
2. With the completed journal admission implementation and native artifact,
   launch the isolated integration fixture through `audit-library-bootstrap.ts`;
   use a fresh real authority database/File principal and only a credential-free
   loopback route. Exercise both no-gate and gate-`pass` required attempts.
3. For gate deny/abort, revoke while prepare awaits, revoke after admission but
   before consumption, and authority/epoch/family-generation changes, require
   zero builtin invocations and zero loopback requests. Replay the exact
   consumed admission and require rejection, not a second dispatch.
4. Observe `begin → lease.beginSend → actual captured builtin invocation →
   finally end` in one stack; prove another root lease can be acquired before the
   returned fetch Promise resolves. A synchronous builtin failure must also
   release the root and leave the admission unusable.
5. Separately hold the real loopback response open after dispatch, revoke the
   family, then finish/drain it. Dispatch-before-revoke is inflight: later packet
   arrival is permitted, and cancellation or a missing packet is not evidence of
   zero charge. Preserve its reservation/unknown accounting until the existing
   outcome/drain contract resolves it. This is not the former zero-wire guarantee
   for revoke after invocation but before runtime-internal network work.

Items 2–5 require the actual journal admission contract; the capture unit suite
does not establish them, provider lifecycle producer coverage, or route approval.


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
