# @oh-my-pi/pi-utils

Shared utilities for [omp](https://github.com/can1357/oh-my-pi) packages. Zero ceremony, Bun-first.

## Notable modules

| Module                                                                                                             | Purpose                                                                                      |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `logger`                                                                                                           | Centralized logger writing to `~/.omp/logs/` with rotation (TUI-safe — never stdout)         |
| `prompt`                                                                                                           | Handlebars-based prompt templating and formatting helpers                                    |
| `dirs`                                                                                                             | Path helpers for omp config directories (`~/.omp`, XDG-aware on Linux)                       |
| `stream`                                                                                                           | `readStream` / `readLines` helpers over `ReadableStream`                                     |
| `ptree` / `procmgr`                                                                                                | Process trees, `ChildProcess` wrapper, process lifecycle management                          |
| `postmortem`                                                                                                       | Cleanup callbacks on exit, signals, and fatal exceptions                                     |
| `which`                                                                                                            | `$which()` binary lookup with caching                                                        |
| `fetch-retry`                                                                                                      | `fetch` with retry/backoff policies                                                          |
| `fs-error`                                                                                                         | Errno guards (`isEnoent` and friends)                                                        |
| `env` / `worker-host`                                                                                              | Environment plumbing and side-effect-free worker-host entry contract (`workerHostEntry`)     |
| `abortable` / `async`                                                                                              | AbortSignal-aware stream/promise helpers                                                     |
| `math-delimiters`                                                                                                  | LaTeX span/block delimiter grammar (offsets only) shared by the TUI and collab-web renderers |
| `peek-file`                                                                                                        | Read the first N bytes of a file with pooled buffers                                         |
| `frontmatter`, `glob`, `mime`, `temp`, `format`, `color`, `snowflake`, `tab-spacing`, `path-tree`, `sanitize-text` | Smaller single-purpose helpers                                                               |

Import from the root barrel or per-module subpaths (`@oh-my-pi/pi-utils/<module>`).

### Model-request journal authority

Import `model-request-journal-leases` and `model-request-journal-authority` through their canonical
`@oh-my-pi/pi-utils/<module>` subpaths. Do not bundle a second copy: verified handles are tied to
the authority module's runtime identity and private object registry.

Raw leases use the OS account home (`os.userInfo()`, not `HOME`) under
`Library/Application Support/omp-security-audit/budget-authority/<storeId>`.
They acquire fixed, never-unlinked control, maintenance, writer-owner and registry accounting
flock files in that order. Acquisition is nonblocking and macOS-only. Dedicated directories
must be owner-only `0700`; files must be owner-only `0600`, without symlinks. The low-level fd
lease helper never removes files; existing area consumers retain their own unlink-before-release
cleanup behavior. Raw scopes do not constitute verified journal authority.

Credential retain/retire/inspect operations centralize secret matching, not role issuance.
Inspection accepts an ordinary authentication snapshot and never creates a binding. Retirement
zeros both retained token buffers and leaves `(writerId, tokenHash)` alias tombstones for the
module lifetime. There is no secret getter, public verified setter, issuer, or reset.

Retention first normalizes every caller-controlled field exactly once, then copies token bytes
with typed-array intrinsics. Alias keys and the retained secret use that same private copy;
uniqueness/retirement checks run only after caller getters have finished. This prevents a
changing token getter from checking a decoy hash while storing a previously retired writer's
secret. Copying and retirement do not invoke caller iterator, species, length or `fill` overrides.

Security regression evidence: the integrating parent reproduced the pre-fix accessor attack
(`getterReads: 5`, alias retained and authenticated). The single-snapshot fix and permanent
changing-getter, reentrant-retirement and overridden-token regressions await the parent's
post-fix verification; the implementation worker has not run checks.

**Implementation boundary:** verified issuance is currently stopped because Bun's public SQLite
API does not expose the actual connection's file descriptor for the required `fstat` identity
check. A separately opened descriptor or `SQLITE_FCNTL_HAS_MOVED` is not accepted as equivalent.
The fixed self-opened read-only codec and negative checks are present, but this is not a completed
managed-binding implementation and does not enable managed sending. No native ABI offsets or
fallback identity proofs are used.

## Install

```sh
bun add @oh-my-pi/pi-utils
```

Ships TypeScript source directly (no build step); requires Bun ≥ 1.3.14.

## References

- [Monorepo README](https://github.com/can1357/oh-my-pi#readme)
- [CHANGELOG](./CHANGELOG.md)
