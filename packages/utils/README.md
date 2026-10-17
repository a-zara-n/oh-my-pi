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

Raw leases use the real UID's OS account home (direct libc `getpwuid_r`, not `HOME`) under
`Library/Application Support/omp-security-audit/budget-authority/<storeId>`.
They acquire fixed, never-unlinked control, maintenance, writer-owner and registry accounting
flock files in that order. Acquisition is nonblocking and macOS-only. Dedicated directories
must be owner-only `0700`; files must be owner-only `0600`, without symlinks. The low-level fd
lease helper never removes files; existing area consumers retain their own unlink-before-release
cleanup behavior. Raw scopes do not constitute verified journal authority.

Account lookup stays inside the existing lazy `bun:ffi` libc boundary. Its public Darwin LP64
layout is derived from macOS SDK 26.2 `usr/include/pwd.h:84–95,102`, `sys/_types.h:72,87`,
`arm/_types.h:119` and `i386/_types.h:143`: `struct passwd` is 72 bytes, with the 32-bit
`pw_uid` at byte 16 and the `pw_dir` pointer at byte 48. This is a public account ABI, not a
private SQLite file layout. `getpwent(3):178–197` specifies caller-owned struct/string storage
and the returned result pointer; `unistd.h:299` supplies `_SC_GETPW_R_SIZE_MAX=71`.
The lookup uses that bounded buffer (at most 1 MiB), validates result/UID/home-pointer range
and UTF-8 before copying the home string, then clears caller-owned native buffers. Unknown
buffer size, `ERANGE`/other lookup errors, missing users and differing real/effective UIDs
reject acquisition; no environment or saved-HOME fallback is used.

The integrating parent's Bun 1.4.2 regressions demonstrated that `os.userInfo().homedir`
returned the supplied fake `HOME`, contrary to the Node compatibility documentation.
Consequently it is not accepted as the account-home source here. The existing subprocess
tests retain distinct fake HOME values and real fixed-namespace contention/kill assertions.

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
(`getterReads: 5`, alias retained and authenticated), then observed the fixed counterexample
read the token once and leave the alias unauthenticated. The worker did not execute checks.
Post-fix verification of direct libc account lookup remains with the parent.

The audit-only `model-request-journal-sqlite-control` subpath owns three operations:
`openModelRequestJournalDatabase`, `createModelRequestJournalDatabase`, and
`assertModelRequestJournalDatabase`, plus their closed options/identity/inspection/initialization types.
Options are only `readonly`, `create`, `strict`, and `safeIntegers` (optional booleans).
Exclusive creation owns `STORE_ID` and `state.sqlite3`; on Darwin it walks directory handles with
public libc `openat`, creates both with `O_EXCL|O_NOFOLLOW`, and generates the 32-hex store ID.
An opaque initialization identity is not operator approval or an active authority claim.
Store's private orchestration must bind its genuine factory result to the fixed schema/seed,
held record, first epoch transaction and active transition. No phase/expected-identity setter exists.

The fixed control allocates its own 256-byte buffer, accepts no caller buffer, and validates the
native protocol/result/state/generations and owned main/WAL/shm identities. Inspection is fd identity
diagnostics, never credential/epoch/readiness authorization. Foreign, closed, replaced or ordinary
system-SQLite connections cannot pass it. Reader assertions independently recheck all live registered
writers on the same path; a reader on A cannot bless a writer still holding B after swap-back.
Ordinary factory opens without the custom library retain Bun behavior; exclusive creation then
returns `identity: undefined`, not a substitute pathname-fd proof.

The authority verifier now self-opens an owned RO connection, installs the fixed native authorizer,
and reads its closed control codec in one actual SELECT-established read transaction. It compares the
authority's device/inode, live writer generations and the same snapshot again before success.
Secrets/policy/verified handles remain in this single JS module, not native code. Native errors propagate;
there is no `HAS_MOVED`, independent-fd, global-hook, pointer-offset or constant-reject fallback.
These are implementation changes, **not a claim of passed acceptance**: parent integration must build
the exact source pin and exercise actual main/WAL/shm lifetime, initial phases and real File readiness.
Earlier actual-fd failures and partial verification records remain historical evidence.

`withRawModelRequestJournalLeases` also supports synchronous callbacks and returns their value
synchronously. Acquisition errors therefore throw before the callback; an async wrapper still exposes
them as rejection. Native Promise results retain the scope until settlement; arbitrary thenables are
rejected without invoking `then`. Nested operations borrow only a genuine private lexical scope,
retain inherited owner/root leases, reject upgrades/different explicit identities, and expire only the
child's local lifetime. A child cannot release its parent's leases. No wait/retry or second lock state
was added.

The isolated preload is `scripts/audit-library-bootstrap.ts`. It verifies the fixed artifact manifest,
signed dylib hash, Bun revision, actual SQLite source ID and exact live compile options before importing
an application graph. It refuses an already initialized SQLite runtime. It performs no network fetch,
global install, normal OMP registration or Keychain operation. See `native/audit-sqlite/README.md` for
the explicit source acquisition/offline build and public-domain provenance. For native utility tests:

```sh
bun --preload ./scripts/audit-library-bootstrap.ts test packages/utils/test/model-request-journal-authority-sqlite.test.ts packages/utils/test/model-request-journal-sqlite-control.test.ts packages/utils/test/model-request-journal-leases.test.ts
```

The two SQLite suites require that real built artifact; they do not mock or skip a missing native
implementation. Run ordinary credential/raw-lease regressions without the preload separately.

## Install

```sh
bun add @oh-my-pi/pi-utils
```

Ships TypeScript source directly (no build step); requires Bun ≥ 1.3.14.

## References

- [Monorepo README](https://github.com/can1357/oh-my-pi#readme)
- [CHANGELOG](./CHANGELOG.md)
