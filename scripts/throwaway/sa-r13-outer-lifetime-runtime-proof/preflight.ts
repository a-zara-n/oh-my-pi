import * as fs from "node:fs";
import * as path from "node:path";
import { integrationRoot, securityAuditRoot } from "./paths.ts";

export function auditSqliteArtifactPresent(): boolean {
	const manifest = path.join(integrationRoot(), "native/audit-sqlite/build/artifact-manifest.json");
	const dylib = path.join(integrationRoot(), "native/audit-sqlite/build/libomp-audit-sqlite.dylib");
	return fs.existsSync(manifest) && fs.existsSync(dylib);
}

export interface PreflightReport {
	readonly integrationRoot: string;
	readonly securityAuditPackage: string;
	readonly smokeRegistersJournalWorkHandles: false;
	readonly auditSqliteArtifactPresent: boolean;
	readonly platform: { readonly darwinArm64: boolean; readonly bunRevision: string };
}

export function runPreflight(): PreflightReport {
	const darwinArm64 = process.platform === "darwin" && process.arch === "arm64";
	return {
		integrationRoot: integrationRoot(),
		securityAuditPackage: securityAuditRoot(),
		smokeRegistersJournalWorkHandles: false,
		auditSqliteArtifactPresent: auditSqliteArtifactPresent(),
		platform: { darwinArm64, bunRevision: Bun.revision },
	};
}

export function assertRunnablePreflight(preflight: PreflightReport): void {
	if (!preflight.platform.darwinArm64) {
		throw new Error("Preflight rejected: darwin/arm64 required for pinned audit SQLite");
	}
	if (!preflight.auditSqliteArtifactPresent) {
		throw new Error("Preflight rejected: native/audit-sqlite/build artifact missing (report parent early)");
	}
	if (!fs.existsSync(path.join(preflight.securityAuditPackage, "src/store/store.ts"))) {
		throw new Error("Preflight rejected: real Store package missing (symlink packages/security-audit)");
	}
}

export function leaseProbeFromRecord(record: Record<string, unknown>): { ok: boolean; acquired?: boolean } {
	if (record.ok !== true) return { ok: false };
	return { ok: true, acquired: record.acquired === true };
}
