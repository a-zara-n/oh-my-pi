import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { patchAmalgamation } from "../native/audit-sqlite/apply-patch";
import { SQLITE_PIN, verifyCanonicalSource } from "../native/audit-sqlite/source";

// Offline, explicit parent/operator build. No runtime imports or downloads.
const [sourceArgument, outputArgument] = process.argv.slice(2);
if (!sourceArgument || !outputArgument || process.argv.length !== 4) throw new Error("Usage: bun scripts/build-audit-sqlite.ts CANONICAL_SOURCE_DIRECTORY NEW_OUTPUT_DIRECTORY");
if (process.platform !== "darwin" || process.arch !== "arm64" || Bun.revision !== SQLITE_PIN.bunRevision) throw new Error("Pinned darwin/arm64 Bun build required");
const canonical = resolve(sourceArgument);
const output = resolve(outputArgument);
verifyCanonicalSource(canonical);
mkdirSync(output, { mode: 0o700 });
const scratch = join(output, "build");
mkdirSync(scratch, { mode: 0o700 });
const inputs = join(scratch, "source");
cpSync(canonical, inputs, { recursive: true, dereference: false, errorOnExist: true, force: false });
// Authenticate the actual private build inputs after the final source read.
// A prior verification of the mutable source pathname is not copy provenance.
const source = verifyCanonicalSource(inputs);
const environment = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: scratch, TMPDIR: scratch, LC_ALL: "C", MACOSX_DEPLOYMENT_TARGET: "14.0", SOURCE_DATE_EPOCH: "1792161920" };
function run(command: string[], cwd = scratch): string {
	const result = Bun.spawnSync(command, { cwd, env: environment, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`Offline SQLite build failed (${command[0]}): ${result.stderr.toString()}`);
	return result.stdout.toString();
}
run([join(inputs, "configure"), "--disable-shared", "--disable-readline", "--disable-editline", "--disable-tcl"]);
run(["/usr/bin/make", "sqlite3.c"]);
const unmodified = readFileSync(join(scratch, "sqlite3.c"));
if (createHash("sha3-256").update(unmodified).digest("hex") !== SQLITE_PIN.amalgamationSha3) throw new Error("Unmodified amalgamation SHA3 rejected; no patch/build performed");
const patched = patchAmalgamation(unmodified.toString("utf8"));
const patchedPath = join(scratch, "sqlite3-owned.c");
writeFileSync(patchedPath, patched, { flag: "wx", mode: 0o600 });
const fragmentDirectory = resolve(import.meta.dir, "../native/audit-sqlite");
const patchHash = createHash("sha256");
for (const file of ["apply-patch.ts", "owned-types.h", "owned-vfs.c", "owned-core.c", "owned-pager.c"]) {
	patchHash.update(file).update("\0").update(readFileSync(join(fragmentDirectory, file))).update("\0");
}
const compilerFlags = [
	"-std=c11", "-D_DARWIN_C_SOURCE", "-O2", "-arch", "arm64", "-mmacosx-version-min=14.0",
	"-DSQLITE_THREADSAFE=1", "-DSQLITE_ENABLE_LOCKING_STYLE=0",
	"-DSQLITE_MAX_MMAP_SIZE=0", "-DSQLITE_DEFAULT_MMAP_SIZE=0",
	"-DSQLITE_DEFAULT_FILE_PERMISSIONS=0600", "-DSQLITE_TEMP_STORE=3",
	"-DSQLITE_OMIT_SHARED_CACHE", "-DSQLITE_ENABLE_API_ARMOR",
	"-DSQLITE_ENABLE_COLUMN_METADATA", "-DSQLITE_ENABLE_FTS5",
	"-DSQLITE_ENABLE_RTREE", "-DSQLITE_ENABLE_DBSTAT_VTAB",
	"-DSQLITE_ENABLE_MATH_FUNCTIONS", "-DSQLITE_ENABLE_NORMALIZE",
	"-DSQLITE_ENABLE_LOAD_EXTENSION", "-DSQLITE_DQS=0",
	"-DSQLITE_DEFAULT_WAL_SYNCHRONOUS=2", "-DSQLITE_USE_URI=1",
];
const filename = "libomp-audit-sqlite.dylib";
const dylib = join(output, filename);
run(["/usr/bin/clang", ...compilerFlags, "-dynamiclib", "-Wl,-install_name,@rpath/" + filename, patchedPath, "-o", dylib, "-lm"]);
run(["/usr/bin/codesign", "--force", "--sign", "-", dylib]);
run(["/usr/bin/codesign", "--verify", "--strict", dylib]);
const probe = join(scratch, "artifact-probe");
run(["/usr/bin/clang", "-arch", "arm64", "-mmacosx-version-min=14.0", "-I", scratch, join(fragmentDirectory, "probe.c"), dylib, "-Wl,-rpath," + output, "-o", probe]);
const probeResult: unknown = JSON.parse(run([probe]));
if (probeResult === null || typeof probeResult !== "object" || !("version" in probeResult) || probeResult.version !== SQLITE_PIN.version || !("sourceId" in probeResult) || probeResult.sourceId !== SQLITE_PIN.sourceId || !("compileOptions" in probeResult) || !Array.isArray(probeResult.compileOptions) || !probeResult.compileOptions.every((option: unknown) => typeof option === "string")) throw new Error("Built SQLite identity/options rejected");
const compileOptions: string[] = probeResult.compileOptions;
compileOptions.sort();
const manifest = {
	schemaVersion: 1,
	platform: "darwin", arch: "arm64", minimumDeploymentTarget: "14.0",
	bunRevision: SQLITE_PIN.bunRevision,
	sqliteVersion: SQLITE_PIN.version, sqliteSourceId: SQLITE_PIN.sourceId,
	unmodifiedAmalgamationSha3: SQLITE_PIN.amalgamationSha3,
	patchSha256: patchHash.digest("hex"),
	patchedSourceSha256: createHash("sha256").update(patched).digest("hex"),
	compileOptions, compilerFlags,
	dylib: { filename, sha256: createHash("sha256").update(readFileSync(dylib)).digest("hex") },
	controlABI: 1, wordCount: 64,
	signature: { kind: "adhoc", verified: true },
	source,
};
writeFileSync(join(output, "artifact-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ manifest: join(output, "artifact-manifest.json"), dylib }));
