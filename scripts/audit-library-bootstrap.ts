// This isolated preload intentionally has no application imports: selecting SQLite must precede their evaluation.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SOURCE_ID = "2026-10-16 14:45:20 555e07ef33f69a0957d24d8e555b702464a131d6f1607f4c3c1e4551e8e6ca76";
const AMALGAMATION_SHA3 = "e2b869d3003b33c942b7dd7063604fbc53553e1b66609570df39b9b7b558ee81";
const BUN_REVISION = "744846f844374847c902b5e7fd59b4342a51ef99";
const artifactDirectory = path.resolve(import.meta.dir, "../native/audit-sqlite/build");
const manifestPath = path.join(artifactDirectory, "artifact-manifest.json");
function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function bytes(filename: string): Buffer {
	const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	try {
		const stat = fs.fstatSync(fd);
		const named = fs.lstatSync(filename);
		if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== named.dev || stat.ino !== named.ino || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) throw new Error("Audit SQLite artifact permissions rejected");
		return fs.readFileSync(fd);
	} finally { fs.closeSync(fd); }
}
if (process.platform !== "darwin" || process.arch !== "arm64" || Bun.revision !== BUN_REVISION) throw new Error("Audit SQLite runtime pin rejected");
const manifest: unknown = JSON.parse(bytes(manifestPath).toString("utf8"));
if (!object(manifest) || manifest.schemaVersion !== 1 || manifest.platform !== "darwin" || manifest.arch !== "arm64" || manifest.minimumDeploymentTarget !== "14.0" || manifest.bunRevision !== BUN_REVISION || manifest.sqliteVersion !== "3.54.1" || manifest.sqliteSourceId !== SOURCE_ID || manifest.unmodifiedAmalgamationSha3 !== AMALGAMATION_SHA3 || manifest.controlABI !== 1 || manifest.wordCount !== 64 || typeof manifest.patchSha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifest.patchSha256) || typeof manifest.patchedSourceSha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifest.patchedSourceSha256) || !object(manifest.source) || manifest.source.checkin !== SOURCE_ID.slice(-64) || manifest.source.manifestSha3 !== SOURCE_ID.slice(-64) || !Number.isSafeInteger(manifest.source.fileCount) || Number(manifest.source.fileCount) < 1 || !object(manifest.signature) || manifest.signature.kind !== "adhoc" || manifest.signature.verified !== true || !Array.isArray(manifest.compileOptions) || manifest.compileOptions.some(value => typeof value !== "string") || !object(manifest.dylib) || manifest.dylib.filename !== "libomp-audit-sqlite.dylib" || typeof manifest.dylib.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifest.dylib.sha256)) throw new Error("Audit SQLite artifact manifest rejected");
const dylibPath = path.join(artifactDirectory, manifest.dylib.filename);
const hash = createHash("sha256").update(bytes(dylibPath)).digest("hex");
if (hash !== manifest.dylib.sha256) throw new Error("Audit SQLite artifact hash rejected");
const signature = spawnSync("/usr/bin/codesign", ["--verify", "--strict", dylibPath], {stdio: "pipe"});
if (signature.error !== undefined) throw signature.error;
if (signature.status !== 0) throw new Error("Audit SQLite artifact signature rejected");
// Bun returns false/throws if SQLite was initialized already. Never probe before this call or load a second copy.
if (!Database.setCustomSQLite(dylibPath)) throw new Error("Audit SQLite was already initialized");
Object.defineProperty(globalThis, Symbol.for("omp.audit.sqlite.required.v1"), {value: true, configurable: false, writable: false});
const probe = new Database(":memory:", {strict: true});
try {
	const version = probe.query<{sourceId: string; version: string}, []>("SELECT sqlite_source_id() AS sourceId,sqlite_version() AS version").get();
	const options = probe.query<{compile_options: string}, []>("PRAGMA compile_options").all().map(row => row.compile_options).sort();
	const expected = [...manifest.compileOptions].sort();
	if (version?.sourceId !== SOURCE_ID || version.version !== "3.54.1" || options.length !== expected.length || options.some((value, index) => value !== expected[index])) throw new Error("Audit SQLite loaded library rejected");
	if (createHash("sha256").update(bytes(dylibPath)).digest("hex") !== hash) throw new Error("Audit SQLite artifact changed during load");
} finally { probe.close(); }

// Preload usage leaves Bun's argv/entry intact. Direct launcher usage is the sole dynamic-import exception:
// the approved loader order requires the application graph to be evaluated only after setCustomSQLite.
if (import.meta.main) {
	const entry = process.argv[2];
	if (entry === undefined || !path.isAbsolute(entry)) throw new Error("Audit SQLite launcher requires an absolute entry path");
	process.argv.splice(1, 2, entry);
	await import(pathToFileURL(entry).href);
}
