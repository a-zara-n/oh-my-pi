import { mkdirSync } from "node:fs";
import * as path from "node:path";

/** Keys the smoke may pass to child processes (explicit allowlist; never spread ambient env). */
export const ALLOWLISTED_ENV_KEYS = [
	"PATH",
	"TMPDIR",
	"TEMP",
	"HOME",
	"XDG_CONFIG_HOME",
	"XDG_CACHE_HOME",
	"XDG_DATA_HOME",
	"PI_CODING_AGENT_DIR",
	"OMP_INTEGRATION_ROOT",
	"OMP_SECURITY_AUDIT_ROOT",
	"OMP_NAMESPACE_ROOT",
	"OMP_SMOKE_CASE",
] as const;

export type AllowlistedEnvKey = (typeof ALLOWLISTED_ENV_KEYS)[number];

export interface IsolatedPaths {
	readonly namespaceRoot: string;
	readonly home: string;
	readonly xdgConfigHome: string;
	readonly xdgCacheHome: string;
	readonly xdgDataHome: string;
	readonly agentDir: string;
}

export function buildIsolatedPaths(namespaceRoot: string): IsolatedPaths {
	const home = path.join(namespaceRoot, "home");
	const xdg = path.join(namespaceRoot, "xdg");
	const xdgConfigHome = path.join(xdg, "config");
	const xdgCacheHome = path.join(xdg, "cache");
	const xdgDataHome = path.join(xdg, "data");
	const agentDir = path.join(namespaceRoot, "agent");
	mkdirSync(home, { recursive: true });
	mkdirSync(xdgConfigHome, { recursive: true });
	mkdirSync(xdgCacheHome, { recursive: true });
	mkdirSync(xdgDataHome, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	return {
		namespaceRoot,
		home,
		xdgConfigHome,
		xdgCacheHome,
		xdgDataHome,
		agentDir,
	};
}

export interface SpawnEnvInput {
	readonly isolated: IsolatedPaths;
	readonly integrationRoot: string;
	readonly securityAuditRoot: string;
}

/** Build child env from explicit values plus only PATH/TMPDIR from the launcher ambient (if present). */
export function buildAllowlistedSpawnEnv(input: SpawnEnvInput): Record<string, string> {
	const values: Partial<Record<AllowlistedEnvKey, string>> = {
		HOME: input.isolated.home,
		XDG_CONFIG_HOME: input.isolated.xdgConfigHome,
		XDG_CACHE_HOME: input.isolated.xdgCacheHome,
		XDG_DATA_HOME: input.isolated.xdgDataHome,
		PI_CODING_AGENT_DIR: input.isolated.agentDir,
		OMP_INTEGRATION_ROOT: input.integrationRoot,
		OMP_SECURITY_AUDIT_ROOT: input.securityAuditRoot,
		OMP_NAMESPACE_ROOT: input.isolated.namespaceRoot,
	};
	const pathVar = process.env.PATH;
	if (pathVar !== undefined && pathVar.length > 0) values.PATH = pathVar;
	const tmp = process.env.TMPDIR ?? process.env.TEMP;
	if (tmp !== undefined && tmp.length > 0) values.TMPDIR = tmp;
	const env: Record<string, string> = {};
	for (const key of ALLOWLISTED_ENV_KEYS) {
		const value = values[key];
		if (value !== undefined && value.length > 0) env[key] = value;
	}
	return env;
}

export function applyWorkerEnvFromProcess(): void {
	for (const key of ALLOWLISTED_ENV_KEYS) {
		const value = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const key of Object.keys(process.env)) {
		if (!ALLOWLISTED_ENV_KEYS.includes(key as AllowlistedEnvKey)) delete process.env[key];
	}
}
