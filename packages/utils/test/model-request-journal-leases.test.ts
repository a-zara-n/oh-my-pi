import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retainRawModelRequestJournalRoot, tryAcquireRawModelRequestJournalFileLease, withRawModelRequestJournalLeases, type RawModelRequestJournalLeaseScope, type RawModelRequestJournalRetainedRootScope } from "../src/model-request-journal-leases";

const mac = process.platform === "darwin" ? describe : describe.skip;
mac("fixed model request journal OS leases", () => {
	test("HOME-independent namespace, fixed control inode, bounded scope, strict modes", async () => {
		const storeId = `test-${randomUUID()}`;
		let namespace: string | undefined;
		let escaped: RawModelRequestJournalLeaseScope | undefined;
		try {
			await withRawModelRequestJournalLeases({storeId, control: "exclusive", maintenance: "exclusive"}, async raw => {
				namespace = raw.namespacePath;
				escaped = raw;
				raw.assertHeld();
				expect(lstatSync(raw.namespacePath).mode & 0o7777).toBe(0o700);
				const control = join(raw.namespacePath, "control", `${storeId}.lock`);
				const before = lstatSync(control);
				expect(before.mode & 0o7777).toBe(0o600);
				writeFileSync(`${raw.recordPath}.new`, "{}", {mode: 0o600});
				renameSync(`${raw.recordPath}.new`, raw.recordPath);
				expect(lstatSync(control).ino).toBe(before.ino);
				const holder = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/model-request-journal-lease-holder.ts"), storeId], {env: {...process.env, HOME: "/not-the-account-home"}, stdout: "pipe", stderr: "pipe"});
				expect(await holder.exited).not.toBe(0);
			});
			const available = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/model-request-journal-lease-holder.ts"), storeId], {stdin: "ignore", env: {...process.env, HOME: "/not-the-account-home"}, stdout: "pipe", stderr: "pipe"});
			const output = await new Response(available.stdout).text();
			const diagnostics = await new Response(available.stderr).text();
			const exitCode = await available.exited;
			if (exitCode !== 0) throw new Error(`Lease fixture exited ${exitCode}: ${diagnostics}`);
			expect(output).toBe("held\n");
			expect(() => escaped?.assertHeld()).toThrow("ended");
		} finally { if (namespace !== undefined) rmSync(namespace, {recursive: true, force: true}); }
	});

	test("real process death releases fixed control and root flock without unlink", async () => {
		for (const registryId of [undefined, "registry-test"]) {
			const storeId = `test-${randomUUID()}`;
			let namespace: string | undefined;
			await withRawModelRequestJournalLeases({storeId, control: "shared", maintenance: "shared"}, async raw => { namespace = raw.namespacePath; });
			const holder = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/model-request-journal-lease-holder.ts"), storeId, ...(registryId === undefined ? [] : [registryId])], {stdin: "pipe", stdout: "pipe", stderr: "pipe", env: {...process.env, HOME: "/different-home"}});
			try {
				const reader = holder.stdout.getReader();
				let output = "";
				for (;;) {
					const ready = await reader.read();
					if (ready.done) {
						const diagnostics = await new Response(holder.stderr).text();
						throw new Error(`Lease fixture exited ${await holder.exited} before readiness: ${diagnostics}`);
					}
					output += new TextDecoder().decode(ready.value);
					if (output.includes("\n")) break;
				}
				expect(output).toBe("held\n");
				reader.releaseLock();
				const request = {storeId, control: "shared" as const, maintenance: "shared" as const, ...(registryId === undefined ? {} : {registryId})};
				await expect(Promise.resolve().then(() => withRawModelRequestJournalLeases(request, async () => {}))).rejects.toThrow();
				holder.kill("SIGKILL");
				await holder.exited;
				await withRawModelRequestJournalLeases(request, async raw => { raw.assertHeld(); });
			} finally {
				holder.kill("SIGKILL");
				await holder.exited;
				if (namespace !== undefined) rmSync(namespace, {recursive: true, force: true});
			}
		}
	}, 15_000);

	test("writer-owner liveness excludes exclusive maintenance probes until scope exit", async () => {
		const storeId = `test-${randomUUID()}`;
		const owner = process.getuid?.();
		if (owner === undefined) throw new Error("Missing test uid");
		let namespace: string | undefined;
		try {
			await withRawModelRequestJournalLeases({storeId, control: "shared", maintenance: "shared", ownerId: "writer-test"}, async raw => {
				namespace = raw.namespacePath;
				expect(tryAcquireRawModelRequestJournalFileLease(join(raw.namespacePath, "owners/writer-test.lock"), "exclusive", owner)).toBeUndefined();
			});
			if (namespace === undefined) throw new Error("Missing test namespace");
			const probe = tryAcquireRawModelRequestJournalFileLease(join(namespace, "owners/writer-test.lock"), "exclusive", owner);
			if (probe === undefined) throw new Error("Owner lease was not released");
			probe.release();
		} finally { if (namespace !== undefined) rmSync(namespace, {recursive: true, force: true}); }
	});

	test("fd extraction rejects symlinks and unsafe mode, preserving caller unlink cleanup", () => {
		const directory = mkdtempSync(join(tmpdir(), "journal-fd-"));
		const path = join(directory, "lease.lock");
		const owner = process.getuid?.();
		if (owner === undefined) throw new Error("Missing test uid");
		try {
			writeFileSync(path, "", {mode: 0o644});
			expect(tryAcquireRawModelRequestJournalFileLease(path, "exclusive", owner)).toBeUndefined();
			chmodSync(path, 0o600);
			symlinkSync(path, join(directory, "alias.lock"));
			expect(tryAcquireRawModelRequestJournalFileLease(join(directory, "alias.lock"), "exclusive", owner)).toBeUndefined();
			const lease = tryAcquireRawModelRequestJournalFileLease(path, "exclusive", owner);
			if (lease === undefined) throw new Error("Real lease unavailable");
			lease.assertHeld();
			rmSync(path);
			lease.release();
			lease.release();
			expect(() => lease.assertHeld()).toThrow("ended");
		} finally { rmSync(directory, {recursive: true, force: true}); }
	});

	test("synchronous scope returns synchronously and nested genuine subset borrows retain owner/root", () => {
		const storeId = `test-${randomUUID()}`;
		let namespace: string | undefined;
		let outer: RawModelRequestJournalLeaseScope | undefined;
		let child: RawModelRequestJournalLeaseScope | undefined;
		try {
			const value = withRawModelRequestJournalLeases({storeId, control: "shared", maintenance: "shared", ownerId: "writer-test", registryId: "root-test"}, raw => {
				namespace = raw.namespacePath;
				outer = raw;
				const nested = withRawModelRequestJournalLeases({storeId, control: "shared", maintenance: "shared"}, borrowed => {
					child = borrowed;
					expect(borrowed.ownerId).toBe("writer-test");
					expect(borrowed.registryId).toBe("root-test");
					borrowed.assertHeld();
					return 7;
				});
				expect(nested).toBe(7);
				expect(() => child?.assertHeld()).toThrow();
				raw.assertHeld();
				expect(() => withRawModelRequestJournalLeases({storeId, control: "exclusive", maintenance: "shared"}, () => {})).toThrow();
				expect(() => withRawModelRequestJournalLeases({storeId, control: "shared", maintenance: "shared", ownerId: "different-owner"}, () => {})).toThrow();
				expect(() => withRawModelRequestJournalLeases({storeId, control: "shared", maintenance: "shared", registryId: "different-root"}, () => {})).toThrow();
				return nested;
			});
			expect(value).toBe(7);
			expect(() => outer?.assertHeld()).toThrow();
			withRawModelRequestJournalLeases({storeId, control: "exclusive", maintenance: "exclusive"}, raw => raw.assertHeld());
		} finally { if (namespace !== undefined) rmSync(namespace, {recursive: true, force: true}); }
	});

	test("throw, hostile thenable and rejected native Promise all expire scopes and release leases", async () => {
		const storeId = `test-${randomUUID()}`;
		let namespace: string | undefined;
		let escaped: RawModelRequestJournalLeaseScope | undefined;
		const request = {storeId, control: "exclusive" as const, maintenance: "exclusive" as const};
		try {
			expect(() => withRawModelRequestJournalLeases(request, raw => {
				namespace = raw.namespacePath;
				escaped = raw;
				throw new Error("body-failure");
			})).toThrow("body-failure");
			expect(() => escaped?.assertHeld()).toThrow();
			let thenRead = false;
			expect(() => withRawModelRequestJournalLeases(request, () => Object.defineProperty({}, "then", {get() { thenRead = true; throw new Error("must-not-run"); }}))).toThrow();
			expect(thenRead).toBe(false);
			await expect(withRawModelRequestJournalLeases(request, async raw => {
				escaped = raw;
				await Promise.resolve();
				raw.assertHeld();
				throw new Error("async-body-failure");
			})).rejects.toThrow("async-body-failure");
			expect(() => escaped?.assertHeld()).toThrow();
			withRawModelRequestJournalLeases(request, raw => raw.assertHeld());
		} finally { if (namespace !== undefined) rmSync(namespace, {recursive: true, force: true}); }
	});

	test("retained root owns a real exclusive fd and synchronously releases only that fd", () => {
		const storeId = `test-${randomUUID()}`;
		const owner = process.getuid?.();
		if (owner === undefined) throw new Error("Missing test uid");
		let namespace: string | undefined;
		let retained: RawModelRequestJournalRetainedRootScope | undefined;
		try {
			withRawModelRequestJournalLeases({storeId, control: "shared", maintenance: "shared", ownerId: "writer-test"}, raw => {
				namespace = raw.namespacePath;
				retained = retainRawModelRequestJournalRoot(raw, "registry-test");
				retained.assertHeld();
				expect(retained.ownerId).toBe("writer-test");
				const root = join(raw.namespacePath, "accounting/registry-test.lock");
				expect(tryAcquireRawModelRequestJournalFileLease(root, "exclusive", owner)).toBeUndefined();
				const busy = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures/model-request-journal-lease-holder.ts"), storeId, "registry-test"], {stdin: "ignore", stdout: "pipe", stderr: "pipe"});
				expect(busy.exitCode).not.toBe(0);
				retained.release();
				// No await or Promise settlement may intervene between release and the OS probe.
				const available = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures/model-request-journal-lease-holder.ts"), storeId, "registry-test"], {stdin: "ignore", stdout: "pipe", stderr: "pipe"});
				expect(available.exitCode).toBe(0);
				expect(available.stdout.toString()).toBe("held\n");
				retained.release();
				expect(() => retained?.assertHeld()).toThrow("ended");
				expect(tryAcquireRawModelRequestJournalFileLease(join(raw.namespacePath, "owners/writer-test.lock"), "exclusive", owner)).toBeUndefined();
				expect(tryAcquireRawModelRequestJournalFileLease(join(raw.namespacePath, "control", `${storeId}.lock`), "exclusive", owner)).toBeUndefined();
				expect(tryAcquireRawModelRequestJournalFileLease(join(raw.namespacePath, "maintenance.lock"), "exclusive", owner)).toBeUndefined();
				raw.assertHeld();
			});
			expect(() => retained?.assertHeld()).toThrow("ended");
		} finally { if (namespace !== undefined) rmSync(namespace, {recursive: true, force: true}); }
	});

	test("retained acquisition rejects busy, forged, root-held and invalid owner scopes", () => {
		const storeId = `test-${randomUUID()}`;
		const owner = process.getuid?.();
		if (owner === undefined) throw new Error("Missing test uid");
		let namespace: string | undefined;
		try {
			withRawModelRequestJournalLeases({storeId, control: "shared", maintenance: "shared"}, raw => {
				namespace = raw.namespacePath;
				expect(() => retainRawModelRequestJournalRoot(raw, "registry-test")).toThrow();
				withRawModelRequestJournalLeases({storeId, control: "shared", maintenance: "shared", ownerId: "writer-test"}, ownerScope => {
					expect(() => retainRawModelRequestJournalRoot({...ownerScope}, "registry-test")).toThrow("rejected");
					expect(() => retainRawModelRequestJournalRoot(ownerScope, "../other-root")).toThrow("rejected");
					const busy = tryAcquireRawModelRequestJournalFileLease(join(raw.namespacePath, "accounting/registry-test.lock"), "exclusive", owner);
					if (busy === undefined) throw new Error("Test root unavailable");
					try { expect(() => retainRawModelRequestJournalRoot(ownerScope, "registry-test")).toThrow("unavailable"); }
					finally { busy.release(); }
					withRawModelRequestJournalLeases({storeId, control: "shared", maintenance: "shared", registryId: "registry-test"}, () => {
						expect(() => retainRawModelRequestJournalRoot(ownerScope, "registry-test")).toThrow("order rejected");
					});
					const retained = retainRawModelRequestJournalRoot(ownerScope, "registry-test");
					try {
						for (const registryId of ["registry-test", "other-root"]) {
							expect(() => retainRawModelRequestJournalRoot(ownerScope, registryId)).toThrow("order rejected");
							expect(() => withRawModelRequestJournalLeases({storeId, control: "shared", maintenance: "shared", registryId}, () => {})).toThrow("order rejected");
						}
						expect(() => withRawModelRequestJournalLeases({storeId, control: "exclusive", maintenance: "shared"}, () => {})).toThrow();
						expect(() => withRawModelRequestJournalLeases({storeId, control: "shared", maintenance: "shared", ownerId: "other-owner"}, () => {})).toThrow();
					} finally { retained.release(); }
				});
			});
		} finally { if (namespace !== undefined) rmSync(namespace, {recursive: true, force: true}); }
	});

	test("matching subset children own retained lifetime and block sibling roots", async () => {
		const storeId = `test-${randomUUID()}`;
		let namespace: string | undefined;
		let retained: RawModelRequestJournalRetainedRootScope | undefined;
		try {
			await withRawModelRequestJournalLeases({storeId, control: "shared", maintenance: "shared", ownerId: "writer-test"}, async raw => {
				namespace = raw.namespacePath;
				const gate = Promise.withResolvers<void>();
				const child = withRawModelRequestJournalLeases({storeId, control: "shared", maintenance: "shared"}, async subset => {
					retained = retainRawModelRequestJournalRoot(raw, "registry-test");
					retained.assertHeld();
					subset.assertHeld();
					await gate.promise;
				});
				expect(() => retainRawModelRequestJournalRoot(raw, "other-root")).toThrow("order rejected");
				withRawModelRequestJournalLeases({storeId, control: "shared", maintenance: "shared"}, () => {
					expect(() => retainRawModelRequestJournalRoot(raw, "other-root")).toThrow("order rejected");
					expect(() => retained?.assertHeld()).toThrow("ended");
				});
				gate.resolve();
				await child;
				expect(() => retained?.assertHeld()).toThrow("ended");
				const next = retainRawModelRequestJournalRoot(raw, "other-root");
				next.assertHeld();
				next.release();
			});
		} finally { if (namespace !== undefined) rmSync(namespace, {recursive: true, force: true}); }
	});

	test("unrelated callbacks, other stores and ended ALS cannot retain a genuine escaped owner", async () => {
		const storeId = `test-${randomUUID()}`;
		const otherStoreId = `test-${randomUUID()}`;
		const gate = Promise.withResolvers<void>();
		let namespace: string | undefined;
		let otherNamespace: string | undefined;
		let escaped: RawModelRequestJournalLeaseScope | undefined;
		const request = {storeId, control: "shared" as const, maintenance: "shared" as const, ownerId: "writer-test"};
		const first = withRawModelRequestJournalLeases(request, async raw => {
			namespace = raw.namespacePath;
			escaped = raw;
			await gate.promise;
		});
		try {
			if (escaped === undefined) throw new Error("Missing owner scope");
			const original = escaped;
			expect(() => retainRawModelRequestJournalRoot(original, "registry-test")).toThrow("rejected");
			withRawModelRequestJournalLeases(request, () => {
				expect(() => retainRawModelRequestJournalRoot(original, "registry-test")).toThrow("rejected");
			});
			withRawModelRequestJournalLeases({...request, ownerId: "other-owner"}, () => {
				expect(() => retainRawModelRequestJournalRoot(original, "registry-test")).toThrow("rejected");
			});
			withRawModelRequestJournalLeases({...request, storeId: otherStoreId}, raw => {
				otherNamespace = raw.namespacePath;
				expect(() => retainRawModelRequestJournalRoot(original, "registry-test")).toThrow("rejected");
			});
			gate.resolve();
			await first;
			let late: Promise<void> | undefined;
			withRawModelRequestJournalLeases(request, raw => {
				late = Promise.resolve().then(() => {
					expect(() => retainRawModelRequestJournalRoot(raw, "registry-test")).toThrow("rejected");
				});
			});
			await late;
		} finally {
			gate.resolve();
			await first;
			if (namespace !== undefined) rmSync(namespace, {recursive: true, force: true});
			if (otherNamespace !== undefined) rmSync(otherNamespace, {recursive: true, force: true});
		}
	});

	test("parent failure releases retained root immediately and preserves a single body error", () => {
		const storeId = `test-${randomUUID()}`;
		const owner = process.getuid?.();
		if (owner === undefined) throw new Error("Missing test uid");
		const failure = new Error("retained-body-failure");
		let namespace: string | undefined;
		let retained: RawModelRequestJournalRetainedRootScope | undefined;
		try {
			let caught: unknown;
			try {
				withRawModelRequestJournalLeases({storeId, control: "shared", maintenance: "shared", ownerId: "writer-test"}, raw => {
					namespace = raw.namespacePath;
					retained = retainRawModelRequestJournalRoot(raw, "registry-test");
					throw failure;
				});
			} catch (error) { caught = error; }
			expect(caught).toBe(failure);
			expect(() => retained?.assertHeld()).toThrow("ended");
			retained?.release();
			if (namespace === undefined) throw new Error("Missing test namespace");
			const available = tryAcquireRawModelRequestJournalFileLease(join(namespace, "accounting/registry-test.lock"), "exclusive", owner);
			if (available === undefined) throw new Error("Retained root not released");
			available.release();
		} finally { if (namespace !== undefined) rmSync(namespace, {recursive: true, force: true}); }
	});

	test("parent settlement invalidates a pending child's retained handle synchronously", async () => {
		const storeId = `test-${randomUUID()}`;
		const owner = process.getuid?.();
		if (owner === undefined) throw new Error("Missing test uid");
		const gate = Promise.withResolvers<void>();
		let namespace: string | undefined;
		let retained: RawModelRequestJournalRetainedRootScope | undefined;
		let child: Promise<void> | undefined;
		try {
			withRawModelRequestJournalLeases({storeId, control: "shared", maintenance: "shared", ownerId: "writer-test"}, raw => {
				namespace = raw.namespacePath;
				child = withRawModelRequestJournalLeases({storeId, control: "shared", maintenance: "shared"}, async () => {
					retained = retainRawModelRequestJournalRoot(raw, "registry-test");
					await gate.promise;
					retained.assertHeld();
				});
			});
			expect(() => retained?.assertHeld()).toThrow("ended");
			if (namespace === undefined || child === undefined) throw new Error("Missing child lifetime fixture");
			const root = tryAcquireRawModelRequestJournalFileLease(join(namespace, "accounting/registry-test.lock"), "exclusive", owner);
			if (root === undefined) throw new Error("Parent settlement left child's root held");
			root.release();
			const rejected = expect(child).rejects.toThrow("ended");
			gate.resolve();
			await rejected;
		} finally {
			gate.resolve();
			if (child !== undefined) {
				try { await child; } catch (error) {
					if (!(error instanceof Error) || !error.message.includes("ended")) throw error;
				}
			}
			if (namespace !== undefined) rmSync(namespace, {recursive: true, force: true});
		}
	});

	test("retained root acquisition rejects non-shared parent modes", () => {
		const storeId = `test-${randomUUID()}`;
		let namespace: string | undefined;
		try {
			for (const mode of ["control", "maintenance"] as const) {
				withRawModelRequestJournalLeases({storeId, control: mode === "control" ? "exclusive" : "shared", maintenance: mode === "maintenance" ? "exclusive" : "shared", ownerId: "writer-test"}, raw => {
					namespace = raw.namespacePath;
					expect(() => retainRawModelRequestJournalRoot(raw, "registry-test")).toThrow("order rejected");
				});
			}
		} finally { if (namespace !== undefined) rmSync(namespace, {recursive: true, force: true}); }
	});
});
