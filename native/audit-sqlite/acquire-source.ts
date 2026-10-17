import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SQLITE_PIN, SOURCE_URL, verifyCanonicalSource } from "./source";

// Explicit operator-only acquisition. Never imported by launcher or build.
const destination = process.argv[2];
const suppliedArchive = process.argv[3];
if (!destination || process.argv.length > 4) throw new Error("Usage: bun native/audit-sqlite/acquire-source.ts NEW_SOURCE_DIRECTORY [PINNED_ARCHIVE]");
const root = resolve(destination);
mkdirSync(root, { mode: 0o700 }); // Exclusive; never merge into an existing tree.
const archivePath = suppliedArchive ? resolve(suppliedArchive) : `${root}.tar.gz`;
if (!suppliedArchive) {
	const response = await fetch(SOURCE_URL, { redirect: "error" });
	if (!response.ok) throw new Error(`Canonical source acquisition failed: ${response.status}`);
	const bytes = Buffer.from(await response.arrayBuffer());
	if (createHash("sha256").update(bytes).digest("hex") !== SQLITE_PIN.archiveSha256) throw new Error("Canonical archive hash rejected");
	writeFileSync(archivePath, bytes, { flag: "wx", mode: 0o600 });
}
const archive = readFileSync(archivePath);
if (createHash("sha256").update(archive).digest("hex") !== SQLITE_PIN.archiveSha256) throw new Error("Pinned archive hash rejected");
// Extract only after authenticating the entire exact already-acquired archive.
const extraction = Bun.spawnSync(["/usr/bin/tar", "-xzf", archivePath, "-C", root, "--strip-components=1"], { env: { PATH: "/usr/bin:/bin", HOME: root }, stdout: "inherit", stderr: "inherit" });
if (extraction.exitCode !== 0) throw new Error("Canonical source extraction failed");
console.log(JSON.stringify(verifyCanonicalSource(root)));
