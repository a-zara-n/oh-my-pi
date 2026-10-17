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
Options are exactly `readonly`, `create`, `strict`, and `safeIntegers` (optional booleans), plus
`purpose?: "general" | "authority-control"`. Omission selects `general`; unknown fields/values
are rejected and the purpose field is never passed to Bun's constructor. General RO retains
native inspect/arm and actual-fd guards while permitting the consumer's existing checked
`query_only OFF → VACUUM INTO → finally ON` backup sequence. Authority-control requires explicit
`readonly:true/create:false` and successful fixed native authorizer setup; it rejects memory probes
and unsupported control even without the required-runtime latch.
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
Inspection includes safe `main`/`wal`/`shm` records (presence `0` pending, `1` present,
`2` not used; generation/device/inode/uid/mode/nlink), never a native pointer or fd.
Only unregistered diagnostics carry `error.code = "ERR_JOURNAL_SQLITE_UNREGISTERED"`.
Ordinary, non-managed callers may classify that code as unsupported only when the audit preload's
non-writable required-library latch is absent; they must never swallow a native fault or managed claim.
Registered connections always use immediate checked `close(true)`, even if a caller requests
unchecked close. This finalizes outstanding prepared statements and surfaces actual native close
failure before acknowledgment. Ordinary unregistered connections retain Bun's close behavior.

On the bootstrapped audit runtime, file-backed factory opens select the fixed nondefault
`omp-owned-v1` VFS through an internally encoded file URI before SQLite opens or reads the
main file. The ordinary default VFS remains upstream-compatible; raw `new Database(...)`
connections cannot be enrolled afterward by the private control command. Selecting the
named VFS is not authority or a secret capability: actual native guards and the private
factory registry remain necessary. The owned route retains its private-parent check and
connection attachment before the initial main-header read, including RO/recovery guards.
An owned connection cannot escape to an ordinary/foreign disk VFS through ATTACH URI options.

The factory continues accepting normal paths, not caller file URIs. It uses `pathToFileURL`
only internally after Bun's existing trim, keeps object `strict`/`safeIntegers` options and
the original path-based writer key, and projects `database.filename` back to Bun's usual
trimmed normal path. This writable JS data projection is never native identity evidence.
Memory probes and non-audit factory opens retain their original Bun constructor path.
No catch-and-reopen fallback, caller-selectable VFS option, new opcode or public API is added;
existing Bun `create:false` behavior is not changed by this correction.

The authority verifier self-opens an owned RO connection with literal `purpose:"authority-control"`,
installs the fixed native authorizer, and reads its closed control codec in one actual
SELECT-established read transaction. It accepts no caller connection/options/purpose.
It compares the authority's device/inode, live writer generations and the same snapshot again before success.
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

DES-004 revision 11 adds synchronous retained-root operations on the same kernels:

- Authority: `retainVerifiedModelRequestJournalRoot(binding, registryId)` returns opaque
  `ModelRequestJournalRetainedRootScope`, extending the existing verified root scope with
  `release(): void`. The existing root scope also projects `ownerId`: the authenticated
  requester's real raw writer-owner ID, **not** the principal's per-epoch journal-owner UUID.
- Raw: `retainRawModelRequestJournalRoot(ownerScope, registryId)` returns opaque
  `RawModelRequestJournalRetainedRootScope`, with actual `ownerId`, `registryId` and synchronous
  `release(): void`. It makes no authority claim. Only the raw kernel's live owner scope in its
  matching current ALS lineage or a genuine matching subset child can be retained.
- The retained operation borrows the parent's control/maintenance/owner leases but obtains its
  **own actual root handle** using existing `LOCK_NB`. Root-held ALS, even for the same root,
  copies, ended scopes, other bindings/owners/stores and conflicting root/order are rejected.
  It does not retain another callback's root or introduce a blocking wait.
- `assertHeld` checks actual handle and private scope/binding lifetime; authority `assertActive`
  additionally repeats fixed database authorization. `release` first irreversibly invalidates
  the retained object, then synchronously unlocks/closes only its root. It is idempotent, but
  released objects never pass assertions or revive. Binding cleanup releases remaining roots
  before its parent writer/control/maintenance leases; release faults are propagated and poison
  that binding/lineage instead of enabling new dispatch.

Existing verified callback APIs and raw synchronous/native-Promise overloads keep their callback
settlement lifetimes for compose/append/ack. The retained API is for the send admission's synchronous
end, not a substitute for joining principal work/drain before ending the binding's writer lifetime.

DES-004 revision 13 / ADR-012 adds **outer work lifetime** on the existing
`@oh-my-pi/pi-utils/model-request-journal-composition` subpath only (no package index re-export):

- `JournalWorkOutcome`, `JournalWorkHandle`, `beginJournalBindingWork(binding)`,
  `beginJournalExecutionWork(execution)` (genuine untracked returns `undefined` only),
  `endJournalWork(handle, outcome)`.
- Handles are opaque branded objects tracked in a private `WeakMap` for **terminal accounting only**.
  They are not a second auth surface for compose/send/I/O. `end` accepts exact active handles even
  after closing/retire/fault; it does not re-require binding=open or execution ready.
- `beginJournalBindingWork` synchronously reuses the authority-installed live binding closure before
  the first `await`. `beginJournalExecutionWork` resolves binding from composition private state and
  rejects forged executions, required rows without a genuine binding, and fault/revoked families.
- Authority termination order: synchronous closing (new `begin`/compose/send rejected) → join all
  registered outer work settlements → existing File principal drain → retained root cleanup → binding
  end → raw lease release. Outer work must not enqueue the authority/principal queue or register the
  authority join promise as work (no self-wait).
- Unsettled actual producers keep the binding alive; timeouts are not converted to success. Missing
  `end`/`begin` pairs are an availability risk, not a sandbox boundary. **Implementation acceptance
  (AC-OL-01〜14, E/S caller wiring, separate-process lease) is not claimed here.**
- `package.json` explicitly denies `./internal/model-request-journal-binding-lifetime` (and `.js`/`.ts`
  aliases). The internal lifetime module remains relative-import only.
No public proof/setter/registration or secret getter is added. Private identity registries are
not a sandbox against arbitrary code or FFI already running inside the host process.

The isolated preload is `scripts/audit-library-bootstrap.ts`. It verifies the fixed artifact manifest,
signed dylib hash, Bun revision, actual SQLite source ID and exact live compile options before importing
an application graph. It refuses an already initialized SQLite runtime. It performs no network fetch,
global install, normal OMP registration or Keychain operation. See `native/audit-sqlite/README.md` for
the explicit source acquisition/offline build and public-domain provenance. For native utility tests:

```sh
bun test --preload ./scripts/audit-library-bootstrap.ts ./packages/utils/test/model-request-journal-authority-sqlite.test.ts ./packages/utils/test/model-request-journal-sqlite-control.test.ts ./packages/utils/test/model-request-journal-leases.test.ts
```

Put the built-in `test` command before `--preload`. The integrating parent observed that
`bun --preload … test …` at the repository root instead selected the root package's `test`
script (`scripts/ci-test-ts.ts local`), whose child did not inherit the preload. That launch
produced six utility failures, including unregistered-connection failures; it is retained as
a failed launch, not erased or counted as evidence of a native runtime regression or acceptance.

The two SQLite suites require that real built artifact; they do not mock or skip a missing native
implementation. Run ordinary credential/raw-lease regressions without the preload separately.

#### Limited parent verification (2026-10-17)

These are the integrating parent's observations, not worker-executed checks:

| Exercised scope | Observed result |
| --- | --- |
| Canonical source verification and corrected native build | 2,287 source records verified; signed dylib and artifact manifest generated |
| `bun test --preload <absolute bootstrap> test/model-request-journal-authority-sqlite.test.ts test/model-request-journal-leases.test.ts`, from `packages/utils` | 12 passed, 0 failed, 46 expectations |
| Credential-authority and raw-lease suites without preload | 14 passed, 0 failed, 71 expectations |
| Real preload/factory smoke | STORE_ID content matched; actual WAL sidecars; RO snapshot retained old data through another writer's commit, next snapshot saw new data; transaction generations increased; close/reopen changed connection generation; rename caused sticky SQL/control rejection |
| SQLite initialized before bootstrap import | Late bootstrap rejected, ordinary table content preserved, required-library latch not minted |
| Native RO WAL recovery before correction | Parent bg331: cold and same-connection cached-map fixtures returned committed data while modifying shm/header; main/WAL remained unchanged |
| Fresh native recovery correction | Parent bg332 build succeeded; bg333 `require-fixed` passed: both RO reads rejected with `SQLITE_READONLY_RECOVERY` (264), full shm/header unchanged, reader control live, legitimate RW recovery/read live |
| Fresh reader-first and terminal-close regressions | Parent bg342: RO SELECT followed by RW UPDATE (`changes:1`), both close successfully; bg343: rename-before-close correctly throws a disk I/O error |
| Retained raw-root actual OS smoke | Parent bg335: external process busy while retained; another process acquires immediately after synchronous release in the same stack; writer lease remains held; released assertion rejects |
| Combined authority/control/raw-lease suites (bg337) | Timed out after 180 seconds; sole emitted failure was authority-control close throwing disk I/O; the finally-close error could mask an earlier try-body failure |
| Limited staged raw-lifetime probe (bg345) | Exit 0 in 0.10 seconds; synchronous busy/release/available and subset gate/child/owner settlement stages completed; not attribution of the combined-suite timeout |
| Separated native denial diagnostic (bg347) | Exit 0 in 0.11 seconds: query-only OFF rejects with AUTH while control stays live; VACUUM INTO rejects with AUTH and leaves no output, but incorrectly changes control to faulted (7178/state2), then close throws; general/backup/writer closes succeed |
| Ordinary/custom-library DDL comparison (bg443–445) | The system/default connection created table/index and read sqlite_master; the selected custom library's ordinary connection failed first CREATE with IOERR_AUTH; the existing owned factory passed. These before observations are retained and are not a post-correction acceptance result |
| Bun URI/options feasibility (bg447, Bun 1.4.2/system SQLite 3.51) | Object strict/safeIntegers options, URI-selected unix VFS, special path characters, BigInt readback and readonly rejection passed; db.filename exposed the URI while PRAGMA database_list reported the real path. This did not exercise the new owned VFS |

The earlier wrong-order launch's six failures remain recorded above. The full three-suite command is
an acceptance invocation, not a claim that all three suites passed: bg337 timed out as recorded.
Concrete test cleanup fixes remove a needless stdin-EOF-dependent synchronous fixture and always
resolve/join a subset child on assertion failure; neither establishes the timeout's root cause.
Purpose/backup, full verified-retained-root integration, Store A0, File-principal C and trusted dispatch remain
unproved here. The recovery fixture's cached mapping is inferred from a prior successful actual
same-connection read, not internal instrumentation. Rename-before-close does not establish an
xClose-only race or actual authority credential misissuance. These limited observations do not
authorize model sending, billing or deployment.

## Install

```sh
bun add @oh-my-pi/pi-utils
```

Ships TypeScript source directly (no build step); requires Bun ≥ 1.3.14.

## References

- [Monorepo README](https://github.com/can1357/oh-my-pi#readme)
- [CHANGELOG](./CHANGELOG.md)
