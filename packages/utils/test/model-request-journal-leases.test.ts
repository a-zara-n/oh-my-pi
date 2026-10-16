import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryAcquireRawModelRequestJournalFileLease, withRawModelRequestJournalLeases, type RawModelRequestJournalLeaseScope } from "../src/model-request-journal-leases";

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
				const holder = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/model-request-journal-lease-holder.ts"), storeId], {env: {...process.env, HOME: "/not-the-account-home"}, stdout: "pipe", stderr: "ignore"});
				expect(await holder.exited).not.toBe(0);
			});
			expect(() => escaped?.assertHeld()).toThrow("ended");
		} finally { if (namespace !== undefined) rmSync(namespace, {recursive: true, force: true}); }
	});

	test("real process death releases fixed control and root flock without unlink", async () => {
		for (const registryId of [undefined, "registry-test"]) {
			const storeId = `test-${randomUUID()}`;
			let namespace: string | undefined;
			await withRawModelRequestJournalLeases({storeId, control: "shared", maintenance: "shared"}, async raw => { namespace = raw.namespacePath; });
			const holder = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/model-request-journal-lease-holder.ts"), storeId, ...(registryId === undefined ? [] : [registryId])], {stdin: "pipe", stdout: "pipe", stderr: "ignore", env: {...process.env, HOME: "/different-home"}});
			try {
				const reader = holder.stdout.getReader();
				const ready = await reader.read();
				expect(new TextDecoder().decode(ready.value)).toBe("held\n");
				reader.releaseLock();
				const request = {storeId, control: "shared" as const, maintenance: "shared" as const, ...(registryId === undefined ? {} : {registryId})};
				await expect(withRawModelRequestJournalLeases(request, async () => {})).rejects.toThrow("unavailable");
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
});
