import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/** Integration repo root (parent moves this tree under `scripts/throwaway/...`). */
export function integrationRoot(): string {
	const override = process.env.OMP_INTEGRATION_ROOT;
	if (override !== undefined && override.length > 0) return path.resolve(override);
	return path.resolve(import.meta.dir, "../../..");
}

export function auditBootstrapEntry(): string {
	return path.join(integrationRoot(), "scripts/audit-library-bootstrap.ts");
}

export function securityAuditRoot(): string {
	const envRoot = process.env.OMP_SECURITY_AUDIT_ROOT;
	const candidates = [
		...(envRoot !== undefined && envRoot.length > 0 ? [path.resolve(envRoot)] : []),
		path.join(integrationRoot(), "packages/security-audit"),
		path.resolve(integrationRoot(), "../../omp-sa-authority-ready-correction/packages/security-audit"),
	];
	for (const root of candidates) {
		if (fs.existsSync(path.join(root, "src/store/index.ts"))) return root;
	}
	throw new Error(
		"Missing real Store package: symlink packages/security-audit or set OMP_SECURITY_AUDIT_ROOT",
	);
}

export function securityAuditStoreIndex(): string {
	return path.join(securityAuditRoot(), "src/store/index.ts");
}

export function securityAuditAuthorityFixtures(): string {
	return path.join(securityAuditRoot(), "test/store/fixtures.ts");
}

export function securityAuditWriterModule(): string {
	return path.join(securityAuditRoot(), "src/store/writer.ts");
}

export function childEntry(name: string): string {
	return path.join(import.meta.dir, name);
}
