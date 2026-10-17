import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	assertModelRequestBuiltinFetch,
	modelRequestBuiltinFetch,
} from "../src/utils/model-request-builtin-fetch";

// These exercise the real Bun builtin. Managed admission/root-release cases belong
// to the actual authority integration suite, not an injected fetch implementation.
describe("canonical startup builtin fetch identity", () => {
	test("accepts the captured real builtin and reaches an isolated loopback", async () => {
		let received = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				received++;
				return new Response(null, { status: 204 });
			},
		});
		try {
			assertModelRequestBuiltinFetch(modelRequestBuiltinFetch);
			const response = await modelRequestBuiltinFetch(server.url, { redirect: "manual" });
			expect(response.status).toBe(204);
			expect(received).toBe(1);
		} finally {
			await server.stop(true);
		}
	});

	test("rejects a caller's queued async sender without invoking it", () => {
		let entered = false;
		const queued = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			entered = true;
			await Promise.resolve();
			return modelRequestBuiltinFetch(input, init);
		};
		expect(() => assertModelRequestBuiltinFetch(queued)).toThrow("canonical startup builtin");
		expect(entered).toBe(false);
	});

	test("rejects a later global replacement without evaluating a caller getter", () => {
		const original = Object.getOwnPropertyDescriptor(globalThis, "fetch");
		if (original === undefined) throw new Error("Bun global fetch descriptor missing");
		let getterCalled = false;
		Object.defineProperty(globalThis, "fetch", {
			configurable: true,
			get() {
				getterCalled = true;
				return modelRequestBuiltinFetch;
			},
		});
		try {
			expect(() => assertModelRequestBuiltinFetch(modelRequestBuiltinFetch)).toThrow("canonical startup builtin");
			expect(getterCalled).toBe(false);
		} finally {
			Object.defineProperty(globalThis, "fetch", original);
		}
	});

	test("rejects a separately evaluated physical module copy", async () => {
		const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "omp-builtin-copy-"));
		const original = path.resolve(import.meta.dir, "../src/utils/model-request-builtin-fetch.ts");
		const copy = path.join(temporary, "model-request-builtin-fetch.ts");
		try {
			await fs.copyFile(original, copy);
			const source = `
import { assertModelRequestBuiltinFetch as canonical, modelRequestBuiltinFetch as builtin } from ${JSON.stringify(original)};
import { assertModelRequestBuiltinFetch as copied } from ${JSON.stringify(copy)};
canonical(builtin);
try { copied(builtin); process.exit(1); } catch { process.exit(0); }
`;
			const child = Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe" });
			const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
		} finally {
			await fs.rm(temporary, { recursive: true, force: true });
		}
	});
});
