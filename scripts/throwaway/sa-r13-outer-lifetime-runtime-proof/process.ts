import type { Subprocess } from "bun";
import * as path from "node:path";
import type { AllowlistedEnvKey } from "./env.ts";
import { auditBootstrapEntry, childEntry, integrationRoot } from "./paths.ts";

export interface SpawnResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
}

export async function drainProcess(
	child: Subprocess<"pipe", "pipe", "pipe">,
	timeoutMs: number,
): Promise<SpawnResult> {
	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];
	let timedOut = false;
	const killer = setTimeout(() => {
		timedOut = true;
		try {
			child.kill();
		} catch {
			/* already exited */
		}
	}, timeoutMs);
	const readStdout = (async () => {
		const reader = child.stdout.getReader();
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				stdoutChunks.push(Buffer.from(chunk.value));
			}
		} finally {
			reader.releaseLock();
		}
	})();
	const readStderr = (async () => {
		const reader = child.stderr.getReader();
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				stderrChunks.push(Buffer.from(chunk.value));
			}
		} finally {
			reader.releaseLock();
		}
	})();
	await Promise.all([readStdout, readStderr, child.exited]);
	clearTimeout(killer);
	return {
		exitCode: child.exitCode ?? 1,
		stdout: Buffer.concat(stdoutChunks).toString("utf8"),
		stderr: Buffer.concat(stderrChunks).toString("utf8"),
		timedOut,
	};
}

/** Spawn via audit bootstrap with an explicit allowlisted env object only (no ambient spread). */
export function spawnWithBootstrap(
	entry: string,
	args: readonly string[],
	allowlistedEnv: Readonly<Record<AllowlistedEnvKey, string>> | Readonly<Record<string, string>>,
): Subprocess<"pipe", "pipe", "pipe"> {
	const bootstrap = auditBootstrapEntry();
	if (!path.isAbsolute(entry)) throw new Error("entry must be absolute");
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(allowlistedEnv)) {
		if (value.length > 0) env[key] = value;
	}
	return Bun.spawn([process.execPath, bootstrap, entry, ...args], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env,
		cwd: integrationRoot(),
	});
}

export async function runLeaseProbe(
	lockPath: string,
	mode: "exclusive" | "shared",
	allowlistedEnv: Readonly<Record<string, string>>,
	timeoutMs: number,
): Promise<SpawnResult & { readonly lines: readonly string[] }> {
	const child = spawnWithBootstrap(childEntry("lease-probe.child.ts"), [lockPath, mode], allowlistedEnv);
	const drained = await drainProcess(child, timeoutMs);
	const lines = drained.stdout
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0);
	return { ...drained, lines };
}

export function parseLastJsonLine(lines: readonly string[]): Record<string, unknown> {
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index];
		if (!line?.startsWith("{")) continue;
		const parsed: unknown = JSON.parse(line);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
	}
	throw new Error("child JSON line missing");
}

/** Worker contract: one JSON document on stdout (compact line preferred; pretty multi-line also accepted). */
export function parseWorkerStdout(stdout: string): Record<string, unknown> {
	const trimmed = stdout.trim();
	if (trimmed.length === 0) throw new Error("worker stdout empty");
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed;
		}
	} catch (wholeError) {
		try {
			return parseLastJsonLine(
				trimmed
					.split("\n")
					.map(line => line.trim())
					.filter(line => line.length > 0),
			);
		} catch {
			const message = wholeError instanceof Error ? wholeError.message : String(wholeError);
			throw new Error(`worker stdout JSON parse failed: ${message}`);
		}
	}
	throw new Error("worker stdout JSON root is not an object");
}
