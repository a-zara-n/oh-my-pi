# Audit-owned SQLite (DES-004 native and factory contracts)

This directory is an isolated, source-owned patch to the canonical SQLite unix
VFS, not an addon, syscall interposer, or fd getter. It must be selected through
Bun `Database.setCustomSQLite` **before the first SQLite load** in the audit
process. It does not configure, install, merge, or deploy normal OMP.

## Reproduce (explicit operator/parent commands)

Required host: macOS/arm64, pinned Bun revision
`744846f844374847c902b5e7fd59b4342a51ef99`, Apple command-line C toolchain.
The compilation floor is macOS 14.0; this is not a claim of validation on macOS
14. The acceptance host is macOS 25.2/arm64. All output directories must be new.

From the integrated checkout, with the already-acquired canonical source:

```sh
bun native/audit-sqlite/source.ts /tmp/sqlite
bun scripts/build-audit-sqlite.ts /tmp/sqlite "$PWD/native/audit-sqlite/build"
```

If a pristine tree is needed, explicit prebuild acquisition is separate:

```sh
bun native/audit-sqlite/acquire-source.ts /private/tmp/omp-sqlite-canonical /tmp/omp-sqlite-555e07ef.tar.gz
bun scripts/build-audit-sqlite.ts /private/tmp/omp-sqlite-canonical "$PWD/native/audit-sqlite/build"
```

Omit only the archive argument to explicitly download the pinned archive. The
acquisition script is never imported by the build or runtime. The build has no
network code, package installation, runtime download, environment library
fallback, or global installation. After its preliminary source check it copies
into the new private 0700 output tree and independently verifies the **actual
copied inputs** before executing their configure/make. The artifact provenance
comes from this copied-tree verification, never the mutable original path's
earlier result. It generates the **unmodified** amalgamation, verifies its SHA3,
applies exact-count source preimages, compiles,
ad-hoc signs (no Keychain), verifies that signature, and probes live metadata
through a tiny native program linked only to that same dylib. Generated source,
probe, and the source build remain inside the output directory, not Git.
`artifact-manifest.json` is emitted last. Do not load a partial output directory.

No build, tests, linter, formatter, loader probe, or runtime smoke was executed by
the native implementation worker. Parent integration must establish those
results; this document does not claim acceptance from source inspection alone.

## Ordinary and named-owned SQLite

Selecting the library does not make every Database managed. Default `unix` and
the other upstream VFS variants retain their original ordinary open/access/
delete, locking, transaction, journal/WAL/shm, VACUUM and close semantics under
the unchanged compile options. Ordinary files/parents need not be 0600/0700;
legal post-open chmod, URI modes, ATTACH/super-journals and memory scratch do not
create owned state. Ordinary native commands 1/2/3 return NOTFOUND, even after
SQL, transactions or WAL use: there is no late-enrollment path.

The fixed nondefault source-owned POSIX variant is **`omp-owned-v1`**. The audit
factory selects it with an internally encoded `file:` URI's `vfs` parameter,
while retaining its existing object options and private registration protocol.
No new factory method, public command, setter, fd/pointer/proof API or global
syscall hook is introduced. Choosing the name alone is not JS factory or
authority proof. External caller URI input remains the factory's rejection
boundary; native actual-fd/namespace records, not the URI or filename property,
remain the proof inputs.

The owned timing is the original timing, not lazy command-1 enrollment:

- SQLite resolves the URI VFS before Btree/Pager open (`src/main.c:3272–3273`,
  `:3351`, `:3643–3644`). The named variant uses the same source-owned unix
  callbacks and POSIX finder, and is registered without replacing default unix
  (`src/os_unix.c:8472–8494`, `:8504–8542`).
- The existing private-parent check remains before the named main's actual
  open. Its fd/stat/parent/generation context and owned methods are attached
  before unixOpen returns, therefore before the first 100-byte main-header read
  (`src/btree.c:2712–2716`, `src/pager.c:3956–3964`). Failed named parent/mode
  startup is rejected during open, not deferred to inspect.
- Commands 1/2 inspect and irreversibly arm that already-owned lifetime.
  Pending mutation/sidecar use, armed identity/namespace/stat/generation faults,
  readonly recovery/extension restrictions and sticky-fault cleanup stay guarded.
  Command 3 fixes actual native readonly/query-only/authorizer policy before
  the authority factory returns and before its first consumer SELECT.

Pager canonicalization still produces the real main/-journal/-wal filenames
and retains its selected VFS (`src/pager.c:4834–4862`, `:4954–4995`).
Sidecars associate with SQLite's exact main object, never a URI/pathname registry.
Ordinary and named-owned POSIX connections may share an upstream inode/shm node;
guards consult this connection's state, not whether another user stamped the
node. Existing readonly readmark capability, RO recovery rejection and immutable
node generations remain distinct from ordinary shared-node capabilities.

Implicit owned disk ATTACH and VACUUM output inherit the named VFS. An explicit
ordinary/foreign disk `vfs=` override is rejected in ATTACH core **before child
open**, including VACUUM INTO's internal ATTACH; otherwise that URI would escape
the early owned boundary. Memory scratch remains memory. Owned output still
requires exclusive creation, binds to the real source and remains
non-authoritative; ordinary VACUUM preserves SQLite's existing empty-output
behavior. Owned path-only deletion stays forbidden; ordinary xDelete keeps its
complete upstream body. Owned journal/WAL deletion still uses checked live fds.

### Regression cause and parent-only commands

At base `f75ee2c`, `apply-patch.ts:20–36` imposed owned policy/attachment on
every unix open. Every ordinary main acquired unarmed state; write checking
(`owned-vfs.c:176–181`) and sidecar attachment (`:464–466`) converted its normal
DDL into sticky IOERR_AUTH/7178. A legal post-open mode change could also fail
the premature stat snapshot. [INFERENCE, source path] These are the rejecting
paths; the supplied runtime observations do not identify which callback failed
first. The fix selects intent before open, not by ignoring a fault, splitting
SQL, or enrolling an ordinary connection afterward.

After integrating both native and factory changes, run from the integration
checkout. Preserve the prior build under an unused name; the output directory
must be new. `/tmp/sqlite` denotes the existing pristine canonical source from
the reproduce instructions; use its actual acquired location if different.

```sh
mv native/audit-sqlite/build native/audit-sqlite/build-before-named-vfs
bun scripts/build-audit-sqlite.ts /tmp/sqlite "$PWD/native/audit-sqlite/build"
DIAGNOSTIC=/Users/azara/.omp/agent/sessions/-.omp/2026-10-12T15-07-06-406Z_01a130a7-3326-77fa-9bba-93fd49852bd2/local/d37-sqlite-ddl-runtime-diagnostic.ts
bun "$DIAGNOSTIC" plain-default
bun --preload "$PWD/scripts/audit-library-bootstrap.ts" "$DIAGNOSTIC" plain-selected
bun --preload "$PWD/scripts/audit-library-bootstrap.ts" "$DIAGNOSTIC" owned-selected
/usr/bin/clang -std=c11 -D_DARWIN_C_SOURCE -arch arm64 -mmacosx-version-min=14.0 -I native/audit-sqlite/build/build native/audit-sqlite/ordinary-compat.c "$PWD/native/audit-sqlite/build/libomp-audit-sqlite.dylib" -Wl,-rpath,"$PWD/native/audit-sqlite/build" -o native/audit-sqlite/build/ordinary-compat
native/audit-sqlite/build/ordinary-compat
bun test --preload "$PWD/scripts/audit-library-bootstrap.ts" ./packages/utils/test/model-request-journal-sqlite-control.test.ts ./packages/utils/test/model-request-journal-authority-sqlite.test.ts
RECOVERY=/Users/azara/.omp/agent/sessions/-.omp/2026-10-12T15-07-06-406Z_01a130a7-3326-77fa-9bba-93fd49852bd2/local/sa-r9-ro-wal-recovery-smoke.ts
bun "$RECOVERY" "$PWD/native/audit-sqlite/build/libomp-audit-sqlite.dylib" require-fixed
```

The build automatically recomputes ordered patch SHA256, patched-source SHA256,
post-sign dylib SHA256 and the final manifest. Do not mix an old manifest with a
new dylib. No source pin, public ABI 1/64-word layout, commands 1/2/3, manifest
schema or build hash-input list changes are needed. The d37 artifact imports the
factory from `/Users/azara/work/omp-fork-sa-r9-integration`; integrate there before
running that unchanged artifact.

`ordinary-compat.c` links the actual new dylib and retains its printed fresh
fixture tree. It covers ordinary DDL/index/master, permissions/URI/metadata,
tx/rollback/ATTACH/temp/VACUUM, real crash-left rollback/WAL recovery and cleanup,
ordinary late-enrollment rejection, named startup refusal before command 1,
decoded named-URI paths, both mixed WAL/node opening orders, readonly
policy-before-first-SELECT/readmarks, owned RW/RO copies, managed VFS-escape
refusal before file creation, pending child writes, identity/namespace/metadata
stickiness and close propagation. It does not replace JS private-registry or
controlled fault acceptance. Parent must also retain unsupported/foreign/
unregistered diagnostics, exact managed close-only/output I/O/close faults,
same-snapshot/generation checks and cold/cached RO recovery byte-preservation
with legitimate RW recovery. No fixture/build/test/diagnostic run is claimed here.


## Canonical provenance and license

- SQLite 3.54.1; source ID:
  `2026-10-16 14:45:20 555e07ef33f69a0957d24d8e555b702464a131d6f1607f4c3c1e4551e8e6ca76`.
- [Canonical check-in](https://sqlite.org/src/info/555e07ef33f69a0957d24d8e555b702464a131d6f1607f4c3c1e4551e8e6ca76).
- [Explicit archive URL](https://sqlite.org/src/tarball/sqlite.tar.gz?r=555e07ef33f69a0957d24d8e555b702464a131d6f1607f4c3c1e4551e8e6ca76).
- Acquired archive SHA256:
  `253eb37dbe624c06d149b48b2aa13dd3eac2de86f8ba13ddf581ca1e904d4a52`.
- Unmodified `sqlite3.c` SHA3-256:
  `e2b869d3003b33c942b7dd7063604fbc53553e1b66609570df39b9b7b558ee81`.
- `source.ts` verifies full raw manifest SHA3 against that check-in,
  `manifest.uuid`, Fossil Z-record MD5, every F-record SHA1/SHA3, executable
  modes, real regular files, no symlinks/hardlinks, path components, no duplicate
  entries, and no untracked build inputs before executing source code.
- The canonical `LICENSE.md` states the SQLite implementation, including
  `sqlite3.c`/`sqlite3.h`, is public domain. Configuration helpers include BSD
  licensed autosetup/autoconf material: preserve the canonical source license
  files if redistributing that source. See [SQLite copyright](https://sqlite.org/copyright.html).
  This repository records acquisition metadata rather than checking in the
  large upstream archive or generated amalgamation. The local patch is under
  the repository's license.

## Closed factory purpose (DES-004 revision 11)

`@oh-my-pi/pi-utils/model-request-journal-sqlite-control` keeps the same three
operations: `openModelRequestJournalDatabase`, `createModelRequestJournalDatabase`
and `assertModelRequestJournalDatabase`. Open options are exactly `readonly?`,
`create?`, `strict?`, `safeIntegers?` (booleans), plus
`purpose?: "general" | "authority-control"`. Unknown fields/values are rejected;
`purpose` is consumed by the factory and never forwarded to Bun's constructor.

Omitted purpose means `general`. Store writer, general query/verification,
backup source/output and pre-migration connections retain this purpose.
General actual-RO connections still require native inspect/arm commands 1/2 in
the audit runtime, retain all fd/sidecar/usage-time guards, and cannot write
their main database. Their consumer may perform its existing checked
`query_only OFF → VACUUM INTO → finally query_only ON` backup sequence.
The copy remains non-authoritative; neither successful SQL nor the same store
ID proves active authority, readiness, or restore cutover.

`authority-control` requires explicit `readonly:true` and `create:false`,
an actual owned file rather than `:memory:`, and successful commands 1/2/3
before return. Native unsupported/failed control rejects even outside a
required runtime. The authority verifier fixes this literal at its own open
site; it does not accept a caller connection, options or purpose. Command 3
keeps trusted schema disabled, query-only enabled and the fixed native
authorizer; attempts to disable query-only or run VACUUM/ATTACH remain rejected.
There is no operation to remove the restriction from an existing connection.
A caller selecting this literal only restricts its own connection and gains
no verified binding. The native ABI and its three commands are unchanged.

## Fixed ABI

Public opcode `0x4f4d5001`, aligned `Uint32Array(64)` (256 bytes), ABI version 1.
All 64-bit integers use low word then high word. No pointers or fd numbers are
returned. The caller must allocate the entire buffer itself; no caller-provided
buffer or DTO is evidence. SQLite's C `sqlite3_file_control(void*)` does **not**
carry the allocation length: native validates alignment and declared length but
cannot authenticate actual TypedArray byteLength. This is the ordinary C API
contract, not a memory-safety guarantee against arbitrary in-process JS/FFI.
Managed proof is the private factory registry and its own fixed codec, not
cryptographic isolation from code that already runs inside the host process.

| Words | Request / response |
| --- | --- |
| 0 | magic `0x4f4d5053` |
| 1 | version 1 |
| 2 | byte count 256 |
| 3 | command: 1 inspect, 2 arm, 3 install fixed read-only policy |
| 4 | native result code |
| 5 | state: 1 live, 2 fault |
| 6–7 | connection generation |
| 8–9 | transaction generation (0 before first transaction attempt) |
| 10 | actual core transaction state: 0 none, 1 read, 2 write |
| 11 | reserved, zero |
| 12–13 | arm request expected main device; reset to zero in response |
| 14–15 | arm request expected main inode; reset to zero in response |
| 16–31 | main record |
| 32–47 | WAL record |
| 48–63 | shm record |

Each 16-word file record: presence at +0 (0 not-yet-open, 1 present,
2 not-used only when core pager is non-WAL and no such owned file), file
generation +1–2, device +3–4, inode +5–6, uid +7, complete stat mode +8,
link count +9, reserved zero +10–15. Entire valid-length response is reset on
every command before output. Fault responses do not contain successful file
records. Invalid header/alignment returns MISUSE without treating stale bytes
as a response. Unknown command never succeeds.

Inspect proves current owned descriptors and namespace. Arm must match the
actual owned main descriptor; it cannot rebind that connection to another
identity. Basic descriptor/namespace checks apply before arm, including initial
main page reads; mutations and sidecar opens require arm. Command 3 requires an
actual read-only, already-armed connection, sets native query-only and
trusted-schema-off, and installs a fixed authorizer. It permits SELECT/READ,
fixed harmless scalar/aggregate functions, fixed read schema/integrity PRAGMAs,
BEGIN/COMMIT/ROLLBACK, and only `trusted_schema=OFF`, `query_only=ON`,
`foreign_keys=ON`, and `recursive_triggers=ON` assignments (or numeric equivalents).
It denies writes, ATTACH/DETACH, extension loading, arbitrary functions, and
other PRAGMAs.
Authority SQL and credentials remain in the JS authority kernel.

Core Btree begin/end notifications use private internal opcode `0x4f4d5002`;
owned journal/WAL deletion uses private internal opcode `0x4f4d5003`.
JS must not use either. Generations are monotonically allocated native lifetimes,
never fd numbers. A transaction attempt gets a new generation before its first
VFS I/O; a read-to-write upgrade retains it. End clears transaction state;
completed generation remains diagnostic until the next attempt. Exhaustion
aborts rather than reusing a lifetime.

## Ownership and callback coverage

`unixFile` embeds its source-owned role, original methods, owned stat, generation,
and reference to a per-main recursive-mutex state. WAL/main-journal `xOpen`
associates through SQLite's public `sqlite3_database_file_object(zPath)` exact
pager relationship, never a global last-open or pathname lookup. The only
disk VFS for managed use is the nondefault source-owned `omp-owned-v1` POSIX
variant; default `unix` remains ordinary. Alternate locking names,
immutable/nolock modes, anonymous disk temporary files and unassociated
super-journals are rejected for managed opens. Temporary work is compiled into
memory. The version probe may use `:memory:` but never as fd evidence.

Every concrete owned file callback is wrapped under the connection lifetime mutex:
read, write, truncate, sync, size, lock/reserved-lock, file-control/size-hint,
sector/capability, shm-map/lock/barrier/unmap, fetch/unfetch, close and reopen.
Main mmap is disabled at compilation. Mutating calls require an armed writer;
read-only shm never implicitly creates, extends, truncates or rebuilds a file.
An actual read-only main connection may open an **existing** shm with O_RDWR
(without O_CREAT), as upstream uses shared writable mappings/readmarks even for
read transactions. Shared-node capability is not main write permission or an
authorizer grant. This prevents a reader-first open from publishing a global
O_RDONLY-only node that would prevent later legitimate writers. Existing
readonly-shm fallback stays intact; no descriptor is replaced/upgraded, and
per-connection guards still prohibit RO creation/rebuild/truncate/extension.

Core `walIndexRecover` also checks the actual owned main connection before its
recovery locks or any mapped-memory mutation. The helper first runs the existing
actual-fd/namespace/sticky-fault checks under that connection's lifetime mutex;
only a valid read-only main receives `SQLITE_READONLY_RECOVERY`, without turning
this permission rejection into a sticky namespace fault. Main readonly state,
not the shared node's writable capability or the WAL fd's open flags, decides
recovery permission. This applies even when `walIndexPage` returns a cached
mapping without another `xShmMap`. Normal readmark locks/writes are unchanged;
valid RW connections retain the original recovery path and BUSY semantics.
Cleanup unlock/unmap/close still release resources after sticky faults but
cannot return a live proof. The void shm barrier and integer capability callbacks
latch faults; the next fallible I/O/control rejects them, and JS must re-inspect
before any successful acknowledgment.

The real `unixShmNode.hShm` is inspected before its first lock/truncate and under
the node mutex before mapping. Node generation, immutable original stat, per-
connection mapping reference, and refcount lifetime distinguish shared nodes,
lazy association, close/reopen and address/fd reuse. No heap-shm substitute is
accepted. Reopened WAL/shm cannot silently change inode within the same native
transaction generation.

Before publication, node stat/generation checks only validate. The connection
commits its node reference/generation only once `pDbFd->pShm` actually points to
that node. In canonical `src/os_unix.c:5052–5083`, a transient DMS BUSY can purge
an unreferenced, unpublished node. Retaining it would leave a stale pointer and
turn a later legitimate retry into sticky AUTH. `src/wal.c:2751–2768`,
`:3182–3190` and `:3493–3495` explain why this may already appear as the first
exposed SQL error: xShmMap BUSY, with no page mapped, becomes WAL_RETRY and the
same SQL call tries again internally. This patch preserves upstream retry
semantics, including SQLITE_PROTOCOL on a persistently held DMS lock after the
retry limit (`:3131–3137`); it does not promise the first public error is BUSY.

All output proof values originate in `fstat` of the existing exact owned file
or shm fd. Directory descriptors and `fstatat(..., AT_SYMLINK_NOFOLLOW)` are
namespace-association checks, not alternative DB descriptor proofs. Directory
walks use `openat`/nofollow for every canonical path component, retain a private
0700 immediate-parent fd, and compare current parent identity on every use.
Ancestors must be root/effective-uid owned and non-group/world-writable except
root-owned sticky temporary directories. Files must be effective-uid-owned,
regular, 0600, nlink 1. Main/WAL/shm namespace identities must match their real
owned descriptors; expected main device/inode stays pinned for the connection.
No HAS_MOVED, unsafe offset, global syscall hook, fd dup, fd export, foreign
library struct, or caller-owned SQLite object is accepted as proof.

This does not claim arbitrary same-uid content-write/rename immunity beyond
DES-004/RK-7 or replace the root/maintenance lease. Named-owned path-only
xAccess validates the trusted namespace but is never descriptor proof.
Named-owned path-only xDelete is deliberately rejected: core journal deletion
reopens through its exact pager if necessary, guards that live owned journal,
then unlinks relative to the owned directory before close; owned WAL deletion
similarly guards/unlinks before close. Ordinary access/deletion stays upstream.
Owned shm deletion is checked while its last live node fd/reference is owned.
These checks do not claim atomic immunity to nonparticipant same-uid renames
between validation and unlink; supported writer/maintenance operations require
the existing lease. Parent acceptance must exercise checkpoint,
recovery/busy/kill, lazy sidecars, multi-process locking, swap-back, same-snapshot
reads, writer COMMIT, callback faults, and loader/export/allocator compatibility.

### Core-owned VACUUM INTO copies

The pinned `src/vacuum.c:223–258` creates/attaches its own output Btree and
checks its initial size; `:397–426` closes that Btree before returning.
The patch adds a source-owned guard **before** that ATTACH, forces exclusive
output creation, and binds the actual output unixFile to the already-armed,
live source before the output transaction. No caller destination setter,
credential, phase flag, public opcode or Bun Database registration is added.

This is only a non-authoritative copy. Its native state is purpose-marked and
cannot be re-armed using public command 2 or become a backup source itself.
Only a new, exclusively-created, zero-size, nofollow/trusted-directory output
is eligible. Its expected identity comes from its actual owned fd; all normal
main/journal/WAL/shm and usage-time guards still apply. Output callbacks also
guard the retained source lifetime. Output binding/I/O/void-callback faults
propagate sticky failure to source state. A core finish guard runs before
output close, close errors propagate, and a final source guard runs after
close and before SQL success. Existing SQL error does not become success.

The finish/source guards keep the ordinary SQL result separate from an owned
lifetime failure. For example, fixed-authority VACUUM INTO can enter the core
routine before its internal ATTACH is rejected by the authorizer
(`src/vacuum.c:225–228`), then reach the final source guard with SQLITE_AUTH and
no output Btree. That refusal must remain a SQL error without poisoning a
still-valid source or causing its later strict close to fail. A non-OK result
alone is not an identity violation. Primary SQLITE_IOERR results (including
extended I/O/guard errors), actual source/output guard failures, invalid output
ownership, and underlying output I/O/close faults still propagate sticky failure.
The source's real owned-file checks always run; no error is changed to success.
An unsuccessful or partial copy never acquires authority/bootstrap eligibility.

Parent acceptance should inspect native state immediately after separate
query_only-OFF and VACUUM-INTO refusals, then close the authority reader:
SQLITE_AUTH stays rejected, the forbidden output stays absent, and valid owned
state/strict close remain successful. Keep the independent true-namespace-swap
close-failure regression; do not hide either result behind a finally exception.

The source may be an actual read-only fd: ordinary Store backup readers can
use their existing query-only-OFF/copy/query-only-ON sequence, and only the
new output owns write permission. Source mutations still fail the native RO
guard. This does not exempt command-3 authority readers: their fixed
authorizer/query-only policy continues to reject VACUUM and ATTACH. The JS
factory must distinguish authority-policy readers from generic Store readers;
native copy code neither removes nor weakens an installed authorizer.

The Store must still re-inspect its registered source connection immediately
after `VACUUM INTO` and before backup acknowledgment. The copy is not in the JS
authority/factory registry, and this native exception mints no authority,
initialization eligibility, binding or ready permission. Failed partial copies
remain unacknowledged and are not silently removed or promoted.

Parent fixture proposal (not executed): keep a real armed Store writer open
with committed WAL events, open a separate armed **actual-readonly** generic
Store reader (without authority command 3), run the existing backup sequence
into a new leaf of another private 0700 directory, restore query-only, and
verify source acknowledgment and copied schema/store ID/event chain through an
ordinary read-only query connection. Repeat with an armed RW source and cover
the existing pre-migration backup. A command-3 authority reader must reject
the same VACUUM request; source-native write attempts must also reject.
Require failure/no backup acknowledgment for existing/empty destination,
symlink destination, untrusted parent, source identity replacement, output
identity replacement during I/O, and output close/void-callback fault. Opening
the resulting copy must not create fresh Store bootstrap eligibility or permit
authority binding. Also cover `VACUUM INTO` SQL failure before and after output
binding, and verify source post-operation inspection catches output failure.

## Artifact manifest

Schema 1 fixes platform/arch, deployment floor, Bun revision, SQLite identity,
unmodified SHA3, patch SHA256 (ordered filename + NUL + bytes + NUL across
`apply-patch.ts`, `owned-types.h`, `owned-vfs.c`, `owned-core.c`, `owned-pager.c`,
`owned-close.c`), patched-source
SHA256, **live** sorted `sqlite3_compileoption_get` strings, separate compiler
flags, dylib filename and post-sign SHA256, control ABI/word count, verified
ad-hoc signature, and canonical manifest root/file count. No artifact hash or
signature is claimed until the parent successfully runs the build. The loader
must pin the resulting manifest/dylib as a pair and independently validate live
SQLite identity/options/control, not equate compiler macros to live options.

Patch maintenance: the shared-memory pre-lock guard is anchored to the complete
`unixLockSharedMemory` function opening and local declarations. The shorter
`SEEK_SET`/`UNIX_SHM_DMS` pair also occurs in the upstream diagnostic lock probe
(`os_unix.c:4689–4690`) and is deliberately not an admissible single-occurrence
preimage. This preserves that diagnostic while guarding the real DMS lifecycle
function (`:4850–4852`) before its first lock operation.
The recovery-entry preimage similarly includes the complete
`walIndexRecover` opening and its local declarations (`src/wal.c:1422–1426`),
with the same exact-one-occurrence rejection as other replacements. The
source-owned static helper lives in the already-hashed `owned-vfs.c`; its call
lives in the already-hashed `apply-patch.ts`. A fresh build therefore updates
the ordered patch SHA256, patched-source SHA256 and signed artifact SHA256
without changing the manifest schema, public commands 1/2/3, private opcodes,
canonical source pin or build hash-input list.

### Terminal close acknowledgment and pinned-consumer contract

Canonical `src/os.h:176` and `src/os.c:82–86` declare `sqlite3OsClose` as void
and discard the concrete xClose result. Journal/WAL cleanup therefore calls it
unconditionally without assigning a return value. The owned concrete xClose
wrapper records the first guard/underlying-close failure in its shared state,
propagates underlying close failures to a retained backup source, and then
releases references. Cleanup is never skipped.
The private `robust_close` error path (`src/os_unix.c:1453–1456`) also records
SQLITE_IOERR_CLOSE in the actual owning state before its normal diagnostic;
upstream otherwise logs this syscall failure without returning it from xClose.

`owned-close.c` privately retains only the already-owned per-main states across
an immediate `sqlite3Close` teardown. It does not retain sqlite3, Btree, Pager,
unixFile, or a pointer into the collector's stack. Before the core releases its
db mutex, the hook uses the same `connectionIsBusy` predicate as
`sqlite3LeaveMutexAndCloseZombie` (`src/main.c:1273–1281`, `:1404–1407`). Only
an immediate close captures state. All native files and the database then
undergo their original complete cleanup/free, after which the hook reads the
retained close result, releases those state references, and returns the error.
No read of the freed sqlite3 object is performed. An intentionally invalidated
normal closed lifetime is not itself an error; actual pre-close guard/close
failures are recorded separately. A deferred close_v2 zombie captures nothing:
no stack collector or additional reference survives its return.

This error-after-complete-cleanup contract is **specific to the pinned Bun
consumer**, not a general SQLite C drop-in guarantee that an error leaves db
alive for sqlite3_errmsg/re-close. At Bun revision
`744846f844374847c902b5e7fd59b4342a51ef99`,
[`src/jsc/bindings/sqlite/JSSQLStatement.cpp:1833–1900`](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/src/jsc/bindings/sqlite/JSSQLStatement.cpp#L1833-L1900)
finalizes its statements for force=true, calls sqlite3_close, unconditionally
sets `versionDB->db=nullptr`, and formats an error using **sqlite3_errstr(rc)**,
not sqlite3_errmsg(db). Thus an error cannot make that consumer re-read or
re-close the freed pointer; subsequent close/GC sees a null handle. Preserving
a SICK database instead would leak it because Bun has already dropped its
pointer. The JS entry is
[`src/js/bun/sqlite.ts:505–509`](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/src/js/bun/sqlite.ts#L505-L509).
The managed factory must always call close(true), even if its caller supplies
false/undefined, to surface close failure before acknowledgment. Normal
unmanaged factories are not altered. Deferred close/foreign outstanding C
backup handles are not successful authority-close acknowledgment paths.

Parent acceptance should cover rename after the last successful RO inspect
but before close, for each caller argument undefined/false/true; each managed
close must throw and invalidate the registry. The observed broad
rename-before-close counterexample establishes propagation failure, not an
observed xClose-only swap window or authority callback false acknowledgment.
Also cover ordinary successful close, sticky-fault cleanup, repeated Bun
close/GC after an error, and reader-first RO/RW coexistence plus DMS release/
retry on the same connection. No execution of these checks is claimed here.

### Read-only WAL recovery boundary

Canonical `src/wal.c:2787–2818` can take the WAL write lock after a malformed
wal-index header and call `walIndexRecover`. That recovery copies hash tables
and writes the shared header/checkpoint metadata (`:1571`, `:1604–1623`), not
just allowed readmarks. Existing-region extension checks alone cannot block
it: `walIndexPage` directly returns a cached mapping (`:837–846`). The WAL fd
itself is normally opened READWRITE even for an RO main (`:1756–1760`).
The guard is consequently at recovery entry and consults only the actual
owned main's immutable per-connection readonly state after the existing guards.

Parent-run regression fixture: use a new private 0700 directory, a fixture-only
writer child that commits a small valid WAL, and an external process retaining
the existing shm DMS shared lock. After the writer child exits, invalidate both
48-byte wal-index headers in the existing 32 KiB shm via actual file I/O.
An RO SELECT must reject without changing the complete shm bytes or main/WAL.
A live RW connection in the same process must then recover and read the
committed row while the RO connection/node remain alive. Run both cold-map and
same-connection cached-map cases; prime the latter with a successful real RO
transaction, inspect its actual shm record, then end that transaction before
invalidating the header. No fake native callbacks or replaced descriptors are
needed.

The local `sa-r9-ro-wal-recovery-smoke.ts` artifact accepts an explicit native
dylib path plus `observe` (identical before/after observations) or `require-fixed`
(assert RO rejection/full-shm preservation and legitimate RW recovery).
Cached-map coverage is derived from that prior real same-connection read and
retained connection lifetime, not internal mapping instrumentation. This fixture
does not prove an arbitrary concurrent mutation window, authority behavior, or
replacement rejection; those retain their separate acceptance checks. The
implementation worker did not execute this fixture or build/check commands.
