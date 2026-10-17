import { describe, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	inspectModelRequestWriterCredential,
	modelRequestJournalAuthorityRuntimeIdentity,
	modelRequestJournalBindingRoles,
	retainModelRequestWriterCredential,
	retireModelRequestWriterCredential,
	withVerifiedModelRequestJournalBinding,
	withVerifiedModelRequestJournalLeases,
	type ModelRequestJournalLeaseBinding,
	type ModelRequestWriterAuthenticationRow,
	type ModelRequestWriterCredential,
} from "../src/model-request-journal-authority";

function fixture(): {
	handle: object;
	credential: ModelRequestWriterCredential;
	row: ModelRequestWriterAuthenticationRow;
} {
	const writerId = `writer_${randomUUID()}`;
	const token = randomBytes(32);
	const handle = Object.freeze({ writerId });
	const credential: ModelRequestWriterCredential = {
		writerId,
		token,
		role: "operator-command",
		capabilities: [],
		identity: { sessionId: "root-session", id: "main-agent", kind: "main", depth: 0 },
	};
	const row: ModelRequestWriterAuthenticationRow = {
		id: writerId,
		role: credential.role,
		tokenHash: createHash("sha256").update(token).digest("hex"),
		capabilitiesJson: "[]",
		sessionId: "root-session",
		agentId: "main-agent",
		kind: "main",
		depth: 0,
		parentWriterId: null,
	};
	return { handle, credential, row };
}

describe("model request credential kernel", () => {
	test("full attribution is authenticated and inactive is ordinary eligibility, not proof", () => {
		const { handle, credential, row } = fixture();
		retainModelRequestWriterCredential(handle, credential);
		try {
			const active = inspectModelRequestWriterCredential(handle, { writer: row, inactive: false });
			expect(active.ok && active.active).toBe(true);
			const ended = inspectModelRequestWriterCredential(handle, { writer: row, inactive: true });
			expect(ended.ok && !ended.active).toBe(true);
			for (const modified of [
				{ ...row, id: "other-writer" },
				{ ...row, role: "harness-core" },
				{ ...row, tokenHash: "0".repeat(64) },
				{ ...row, capabilitiesJson: '["review"]' },
				{ ...row, sessionId: "other-session" },
				{ ...row, agentId: "other-agent" },
				{ ...row, kind: "sub" },
				{ ...row, depth: 1 },
				{ ...row, parentWriterId: "other-parent" },
			])
				expect(inspectModelRequestWriterCredential(handle, { writer: modified, inactive: false }).ok).toBe(false);
			expect(inspectModelRequestWriterCredential({ ...handle }, { writer: row, inactive: false }).ok).toBe(false);
		} finally {
			retireModelRequestWriterCredential(handle);
		}
	});

	test("handle replacement and copied-token aliases remain rejected after retirement", () => {
		const { handle, credential, row } = fixture();
		const alias = { ...credential, token: Uint8Array.from(credential.token) };
		retainModelRequestWriterCredential(handle, credential);
		expect(() => retainModelRequestWriterCredential(handle, credential)).toThrow("credential rejected");
		expect(() => retainModelRequestWriterCredential({}, alias)).toThrow("alias rejected");
		expect(credential.token.some(value => value !== 0)).toBe(true);
		retireModelRequestWriterCredential(handle);
		expect(credential.token.every(value => value === 0)).toBe(true);
		expect(inspectModelRequestWriterCredential(handle, { writer: row, inactive: false })).toEqual({
			ok: false,
			reason: "retired",
		});
		expect(() => retainModelRequestWriterCredential({}, alias)).toThrow("alias rejected");
		expect(() => retainModelRequestWriterCredential(handle, alias)).toThrow("credential rejected");
	});

	test("a changing token getter cannot authenticate a retired writer through a different hash tombstone", () => {
		const original = fixture();
		const savedToken = Uint8Array.from(original.credential.token);
		retainModelRequestWriterCredential(original.handle, original.credential);
		retireModelRequestWriterCredential(original.handle);
		const differentToken = randomBytes(32);
		let tokenReads = 0;
		const alias = {
			...original.credential,
			get token(): Uint8Array {
				tokenReads++;
				return tokenReads === 4 ? savedToken : differentToken;
			},
		};
		const aliasHandle = {};
		try {
			retainModelRequestWriterCredential(aliasHandle, alias);
			expect(tokenReads).toBe(1);
			expect(inspectModelRequestWriterCredential(aliasHandle, { writer: original.row, inactive: false }).ok).toBe(
				false,
			);
			expect(() => retainModelRequestWriterCredential({}, { ...original.credential, token: savedToken })).toThrow(
				"alias rejected",
			);
		} finally {
			retireModelRequestWriterCredential(aliasHandle);
		}
	});

	test("caller getters can retire a handle during normalization but cannot revive it", () => {
		const { credential, row } = fixture();
		const handle = {};
		let roleReads = 0;
		const reentrant = {
			...credential,
			get role(): ModelRequestWriterCredential["role"] {
				roleReads++;
				retireModelRequestWriterCredential(handle);
				return "operator-command";
			},
		};
		expect(() => retainModelRequestWriterCredential(handle, reentrant)).toThrow("credential rejected");
		expect(roleReads).toBe(1);
		expect(credential.token.some(value => value !== 0)).toBe(true);
		expect(inspectModelRequestWriterCredential(handle, { writer: row, inactive: false })).toEqual({
			ok: false,
			reason: "retired",
		});
	});

	test("token copy and retirement use typed-array intrinsics rather than caller overrides", () => {
		const { handle, credential, row } = fixture();
		for (const property of ["length", "slice", "fill", Symbol.iterator, "constructor"]) {
			Object.defineProperty(credential.token, property, {
				get() {
					throw new Error("Caller token override invoked");
				},
			});
		}
		retainModelRequestWriterCredential(handle, credential);
		try {
			expect(inspectModelRequestWriterCredential(handle, { writer: row, inactive: false }).ok).toBe(true);
		} finally {
			retireModelRequestWriterCredential(handle);
		}
		expect(Uint8Array.prototype.every.call(credential.token, (value: number) => value === 0)).toBe(true);
	});

	test("tombstones bind writer and hash together, not unrelated stores' token values", () => {
		const first = fixture();
		const second = fixture();
		const credential = { ...second.credential, token: Uint8Array.from(first.credential.token) };
		retainModelRequestWriterCredential(first.handle, first.credential);
		try {
			retainModelRequestWriterCredential(second.handle, credential);
			retireModelRequestWriterCredential(second.handle);
		} finally {
			retireModelRequestWriterCredential(first.handle);
		}
	});

	test("closed credential fields and fixed role values reject runtime bypasses", () => {
		for (const mutation of [
			{ role: "superuser" },
			{ unexpected: true },
			{ token: new Uint8Array(31) },
			{ capabilities: ["admin"] },
			{ identity: { sessionId: "root", id: "agent", kind: "main", depth: 0, extra: true } },
		]) {
			const { credential } = fixture();
			const malformed = { ...credential, ...mutation } as unknown as ModelRequestWriterCredential;
			expect(() => retainModelRequestWriterCredential({}, malformed)).toThrow("credential rejected");
		}
		expect(Object.isFrozen(modelRequestJournalBindingRoles)).toBe(true);
		expect(Object.isFrozen(modelRequestJournalBindingRoles.resume)).toBe(true);
		expect(() => Reflect.set(modelRequestJournalBindingRoles.resume, "0", "model-agent")).not.toThrow();
		expect(modelRequestJournalBindingRoles.resume).toEqual(["operator-command", "harness-core"]);
	});

	test("fake inspect success and matching public identity cannot mint verified state", async () => {
		const { handle, credential, row } = fixture();
		retainModelRequestWriterCredential(handle, credential);
		try {
			expect(inspectModelRequestWriterCredential(handle, { writer: row, inactive: false }).ok).toBe(true);
			const fake = {
				runtimeIdentity: modelRequestJournalAuthorityRuntimeIdentity,
				rootSessionId: "root-session",
			} as unknown as ModelRequestJournalLeaseBinding;
			let entered = false;
			await expect(
				withVerifiedModelRequestJournalLeases(fake, "registry", async () => {
					entered = true;
				}),
			).rejects.toThrow("unverified");
			expect(entered).toBe(false);
			await expect(
				withVerifiedModelRequestJournalBinding(
					{
						resources: { storeId: randomUUID(), databasePath: "/missing" },
						requester: {},
						mode: "resume",
						rootSessionId: "root-session",
					},
					async () => {
						entered = true;
					},
				),
			).rejects.toThrow("unsupported");
			expect(entered).toBe(false);
		} finally {
			retireModelRequestWriterCredential(handle);
		}
	});
});
