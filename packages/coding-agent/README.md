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

`createAgentSession` accepts the optional internal `modelRequestJournalLeaseBinding` only as an
opaque handle from `@oh-my-pi/pi-utils/model-request-journal-authority`. A raw OS lease, copied
object, session ID, manager, or alternate runtime instance is not authority. The SDK carries the
same object through root assignment, child sessions, and revival; it does not serialize the handle.
Conflicting explicit and inherited bindings are rejected.

Before publishing a managed execution, the SDK awaits
`bindModelRequestJournalComposition(manager, { execution, rootManager, leases, acceptJournal })`.
The root manager is the actual matching live manager, not one reopened from a caller-provided
path. The manager owns the fixed authority verification and must obtain the real registry receipt,
source header acknowledgement, and owner before returning success. Receiving a sink callback
alone does not release the SDK's private sink-slot barrier.

**Work in progress:** the actual registry receipt producer and an authenticated bridge from that
receipt to the exact ai runtime execution are not yet available. The context's private promise
only transports the sink; it is never trusted as runtime readiness. Managed runtime authorization
therefore remains closed, even if a caller supplies a resolved promise or a gate would pass.
This is an unresolved design/integration boundary, not a completed managed sending path.

The prior WIP runtime-only refusal did not cover the wire: three no-gate shortcuts in pi-ai
could bypass authorization. Their fast paths now apply only to executions without a managed
binding (`gatedSend`, `authorizeUninstrumentedAttempt`, and the uninstrumented stream wrapper).
Permanent regressions and a before/after loopback smoke are prepared, not run by this worker;
actual wire measurements remain pending parent verification.

Normal SDK use without a binding, including sinkless custom providers, is unchanged.

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
