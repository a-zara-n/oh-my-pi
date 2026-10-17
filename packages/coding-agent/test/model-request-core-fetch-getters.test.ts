import { describe, expect, test } from "bun:test";
import * as path from "node:path";

// Selection only, never authority evidence. The fresh child authenticates its
// actual owned SQLite connection, writer credential and epoch through the fixed verifier.
const nativePreloaded =
	Object.getOwnPropertyDescriptor(globalThis, Symbol.for("omp.audit.sqlite.required.v1"))?.value === true;

const callers = [
	"compaction-v2-streaming",
	"openai-remote-compaction",
	"generic-remote-compaction",
	"native-judge",
];

describe("D37 core caller fetch construction (native authority)", () => {
	test.skipIf(!nativePreloaded)(
		"required-pending rejects all four real callers before reading the global fetch getter",
		async () => {
			const fixture = path.join(import.meta.dir, "fixtures/model-request-core-fetch-getters-process.ts");
			const bootstrap = path.resolve(import.meta.dir, "../../../scripts/audit-library-bootstrap.ts");
			const child = Bun.spawn([process.execPath, "--preload", bootstrap, fixture], {
				cwd: path.resolve(import.meta.dir, "../../.."),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				timeout: 25_000,
			});
			try {
				const [exitCode, stdout, stderr] = await Promise.all([
					child.exited,
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				]);
				if (exitCode !== 0) {
					throw new Error(`Core fetch getter fixture exited ${exitCode}:\n${stdout}\n${stderr}`);
				}
				const output: unknown = JSON.parse(stdout);
				if (output === null || typeof output !== "object" || Array.isArray(output)) {
					throw new Error("Core fetch getter fixture did not return a JSON object");
				}
				if (!("journalState" in output)) throw new Error("Fixture omitted its actual journal state");
				expect(output.journalState).toBe("required-pending");
				if (!("results" in output) || !Array.isArray(output.results)) {
					throw new Error("Core fetch getter fixture omitted caller results");
				}
				const results: readonly unknown[] = output.results;
				expect(results).toHaveLength(callers.length);
				for (const [index, result] of results.entries()) {
					if (result === null || typeof result !== "object" || Array.isArray(result)) {
						throw new Error("Core fetch getter fixture returned an invalid caller result");
					}
					const caller = callers[index];
					expect(result).toMatchObject({
						caller,
						getterCalls: 0,
						completed: false,
						callbackReached: false,
						constructionOnly: caller === "native-judge",
					});
					if (!("error" in result) || typeof result.error !== "string") {
						throw new Error(`Caller ${caller} did not report its rejection`);
					}
					expect(result.error.trim().length).toBeGreaterThan(0);
				}
			} finally {
				if (child.exitCode === null) {
					child.kill("SIGKILL");
					await child.exited;
				}
			}
		},
		30_000,
	);
});
