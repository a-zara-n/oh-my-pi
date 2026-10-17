import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const SQLITE_PIN = Object.freeze({
	version: "3.54.1",
	checkin: "555e07ef33f69a0957d24d8e555b702464a131d6f1607f4c3c1e4551e8e6ca76",
	sourceId: "2026-10-16 14:45:20 555e07ef33f69a0957d24d8e555b702464a131d6f1607f4c3c1e4551e8e6ca76",
	amalgamationSha3: "e2b869d3003b33c942b7dd7063604fbc53553e1b66609570df39b9b7b558ee81",
	archiveSha256: "253eb37dbe624c06d149b48b2aa13dd3eac2de86f8ba13ddf581ca1e904d4a52",
	bunRevision: "744846f844374847c902b5e7fd59b4342a51ef99",
});
export const SOURCE_URL = `https://sqlite.org/src/tarball/sqlite.tar.gz?r=${SQLITE_PIN.checkin}`;

/** Verify every tracked byte before executing upstream configuration/build code. */
export function verifyCanonicalSource(directory: string): { checkin: string; manifestSha3: string; fileCount: number } {
	const root = resolve(directory);
	if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
		throw new Error("Source root is not a real directory");
	for (const file of ["manifest", "manifest.uuid", "manifest.tags"]) {
		const stat = lstatSync(join(root, file));
		if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Source manifest file rejected");
	}
	const manifestBytes = readFileSync(join(root, "manifest"));
	const manifest = manifestBytes.toString("utf8");
	const rootHash = createHash("sha3-256").update(manifestBytes).digest("hex");
	if (
		rootHash !== SQLITE_PIN.checkin ||
		readFileSync(join(root, "manifest.uuid"), "utf8").trim() !== SQLITE_PIN.checkin
	)
		throw new Error("Canonical manifest root/checkin rejected");
	if (
		readFileSync(join(root, "manifest.tags"), "utf8") !==
		"branch branch-3.54\ntag release\ntag branch-3.54\ntag version-3.54.1\n"
	)
		throw new Error("Canonical manifest tag metadata rejected");
	const trailer = /Z ([a-f0-9]{32})\n$/.exec(manifest);
	if (!trailer || createHash("md5").update(manifest.slice(0, trailer.index)).digest("hex") !== trailer[1])
		throw new Error("Fossil manifest checksum rejected");
	const tracked = new Set(["manifest", "manifest.uuid", "manifest.tags"]);
	let count = 0;
	for (const line of manifest.split("\n")) {
		if (!line.startsWith("F ")) continue;
		const fields = line.split(" ");
		if (fields.length < 3 || fields.length > 4) throw new Error("Manifest F record rejected");
		const encoded = fields[1];
		const digest = fields[2];
		if (encoded === undefined || digest === undefined || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(digest))
			throw new Error("Manifest file digest rejected");
		const path = encoded.replace(/\\([sntvrf\\])/g, (_match, value: string) => {
			const escapes: Record<string, string> = { s: " ", n: "\n", t: "\t", v: "\v", r: "\r", f: "\f", "\\": "\\" };
			const decoded = escapes[value];
			if (decoded === undefined) throw new Error("Unknown Fossil escape");
			return decoded;
		});
		if (
			path.includes("\\") ||
			path.startsWith("/") ||
			path.split("/").some(part => part === "" || part === "." || part === "..") ||
			tracked.has(path)
		)
			throw new Error("Manifest file path rejected");
		if (fields[3] !== undefined && fields[3] !== "x")
			throw new Error("Pinned source does not permit symlinks/unknown modes");
		let current = root;
		const parts = path.split("/");
		for (const [index, part] of parts.entries()) {
			current = join(current, part);
			const stat = lstatSync(current);
			if (
				stat.isSymbolicLink() ||
				(index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
			)
				throw new Error("Source component type rejected");
			if (index === parts.length - 1 && ((stat.mode & 0o111) !== 0) !== (fields[3] === "x"))
				throw new Error("Source executable mode rejected");
		}
		const actual = createHash(digest.length === 40 ? "sha1" : "sha3-256")
			.update(readFileSync(current))
			.digest("hex");
		if (actual !== digest) throw new Error(`Source F record hash rejected: ${path}`);
		tracked.add(path);
		count++;
	}
	// No unverified local script/configuration may enter the offline build copy.
	function visit(relative: string): void {
		for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
			const name = relative ? `${relative}/${entry.name}` : entry.name;
			if (entry.isDirectory()) visit(name);
			else if (!entry.isFile() || !tracked.has(name)) throw new Error(`Untracked source input rejected: ${name}`);
		}
	}
	visit("");
	if (count === 0 || readFileSync(join(root, "VERSION"), "utf8").trim() !== SQLITE_PIN.version)
		throw new Error("Source version/count rejected");
	return { checkin: SQLITE_PIN.checkin, manifestSha3: rootHash, fileCount: count };
}
if (import.meta.main) {
	const source = process.argv[2];
	if (!source || process.argv.length !== 3)
		throw new Error("Usage: bun native/audit-sqlite/source.ts SOURCE_DIRECTORY");
	console.log(JSON.stringify(verifyCanonicalSource(source)));
}
