# @oh-my-pi/pi-coding-agent

Core implementation package for the `omp` coding agent in the `omp` monorepo.

For installation, setup, provider configuration, model roles, slash commands, and full CLI reference, see:
- [Monorepo README (local)](../../README.md)
- [Monorepo README (GitHub)](https://github.com/can1357/oh-my-pi#readme)

Package-specific references:
- [CHANGELOG](./CHANGELOG.md)
- [MCP configuration guide](../../docs/mcp-config.md)
- [MCP runtime lifecycle](../../docs/mcp-runtime-lifecycle.md)
- [MCP server/tool authoring](../../docs/mcp-server-tool-authoring.md)
- [DEVELOPMENT](./DEVELOPMENT.md)

## Internal managed journal handoff

Outer producer lifetime (ADR-012 / DES-004 §6.7.2i) is wired through the canonical SDK and session
sources listed in the design responsibility table: each fixed entry synchronously `begin`s on the
composition subpath before its first `await`, then `end`s only after the actual futures it started
(including detached extension emits, handler registration flush, executor late dispose, and Mnemopi
post-timeout consolidate) settle. Runtime AC-OL acceptance is exercised separately from this package
README; see `test/journal-outer-work-callers.test.ts`.

`createAgentSession` accepts the optional internal `modelRequestJournalLeaseBinding` only as an
opaque handle from `@oh-my-pi/pi-utils/model-request-journal-authority`. A raw OS lease, copied
object, session ID, manager, or alternate runtime instance is not authority. The SDK carries the
same object through root assignment, child sessions, and revival; it does not serialize the handle.
Conflicting explicit and inherited bindings are rejected.

Before publishing a managed execution, the SDK awaits
`bindModelRequestJournalComposition(manager, { execution, rootManager, leases })`.
The manager resolves its actual File principal and delegates composition; the manager,
its getters, a supplied storage object, and a promise are not provenance proofs.
The same principal owns the File header, generation, queue, writer, registry, owner,
and execution family. Manager transcript/header/leaf state is a revision-keyed
projection of that principal; ordinary lazy staging and committed disk state remain
distinct inside the principal.

Composition writes and independently reads the actual root member/owner registrations,
then writes and reads the source descriptor before creating the opaque owner/session.
The two append operations preserve closed metadata and source identities. Normal
storage instances and writers cannot create, strip, or rewrite closed metadata.
Session replacement, movement, supersession, close, and release invalidate the affected
execution families rather than replacing their identity with caller-supplied values.

Readiness checks cover gated and no-gate entries, including omitted executions after
the irreversible journal-required latch, and run again after authorization/provider
waits. Ordinary untracked, sinkless operation retains its existing path before that
latch; omitting a binding or execution does not clear a required family.

Managed wire dispatch remains unsupported in this checkout. The approved dispatch
start boundary still needs a genuine, synchronously releasable short root scope.
Durable journal-owner/lease correspondence and canonical core-agent identity also
remain acceptance prerequisites: a locally reported ready state is not evidence that
these integration conditions have been satisfied. No pass-loopback managed-send
acceptance or runtime verification is claimed here.

## Memory backends

The agent supports three mutually-exclusive memory backends, selected via the `memory.backend` setting (Settings → Memory tab, or `~/.omp/config.yml`):

- `off` (default) — no memory subsystem runs.
- `local` — existing rollout-summarisation pipeline; writes `memory_summary.md` and consolidated artifacts under the agent dir.
- `hindsight` — talks to a [Hindsight](https://hindsight.vectorize.io) server (Cloud or self-hosted Docker), retains transcripts every Nth user turn, recalls memories on the first turn of a session, and exposes `retain`, `recall`, and `reflect`.

### Hindsight quickstart

1. Run a Hindsight server (Cloud or `docker run -p 8888:8888 ghcr.io/vectorize-io/hindsight:latest`).
2. Set `memory.backend = "hindsight"` and `hindsight.apiUrl = "http://localhost:8888"` (or your Cloud URL).
3. Optional environment overrides (env wins over settings):
   - `HINDSIGHT_API_URL`, `HINDSIGHT_API_TOKEN` — connection
   - `HINDSIGHT_BANK_ID`, `HINDSIGHT_DYNAMIC_BANK_ID`, `HINDSIGHT_AGENT_NAME` — bank addressing
   - `HINDSIGHT_AUTO_RECALL`, `HINDSIGHT_AUTO_RETAIN`, `HINDSIGHT_RETAIN_MODE` — lifecycle
   - `HINDSIGHT_RECALL_BUDGET`, `HINDSIGHT_RECALL_MAX_TOKENS` — recall sizing
   - `HINDSIGHT_BANK_MISSION`, `HINDSIGHT_DEBUG`

Switching backends mid-session immediately replaces the live backend, memory tools, listeners, and system-prompt context. Existing users with `memories.enabled = true|false` are migrated to `memory.backend = "local"|"off"` exactly once on first launch; afterward, `memory.backend` is the sole runtime selector.
