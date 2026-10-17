import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ModelRequestJournalLeaseBinding } from "@oh-my-pi/pi-utils/model-request-journal-authority";
import { withRawModelRequestJournalLeases } from "@oh-my-pi/pi-utils/model-request-journal-leases";
import {
	securityAuditAuthorityFixtures,
	securityAuditStoreIndex,
	securityAuditWriterModule,
} from "./paths.ts";

type StoreModule = typeof import("omp-security-audit/store");
type WriterModule = typeof import("omp-security-audit/store/writer");
type WriterHandle = WriterModule["WriterHandle"];
type OpenedStore = Extract<StoreModule.OpenStoreResult<WriterHandle>, { ok: true }>["store"];

export interface AuthorityHarness {
	readonly store: OpenedStore;
	readonly operator: WriterHandle;
	readonly core: WriterHandle;
	readonly storeRoot: string;
	readonly parentPath: string;
	close(): void;
}

/** Runtime evidence: Store lease binding vs SDK-equivalent authority import (same public specifier). */
export interface JournalRuntimeIdentityEvidence {
	readonly bindingMatchesSdkAuthorityImport: boolean;
	readonly readingPaths: {
		readonly sdk: string;
		readonly storeBinding: string;
		readonly canonicalModule: string;
	};
}

/**
 * SDK validates lease bindings against `modelRequestJournalAuthorityRuntimeIdentity` from
 * `@oh-my-pi/pi-utils/model-request-journal-authority` (coding-agent sdk.ts). Store issues bindings via
 * the same specifier (security-audit store.ts → withVerifiedModelRequestJournalBinding). Smoke compares
 * binding.runtimeIdentity to a fresh import of that specifier after exact public pins + preload.
 */
export async function assertGenuineBinding(
	binding: ModelRequestJournalLeaseBinding,
): Promise<JournalRuntimeIdentityEvidence> {
	const authority = await import("@oh-my-pi/pi-utils/model-request-journal-authority");
	const sdkAuthorityIdentity = authority.modelRequestJournalAuthorityRuntimeIdentity;
	const bindingMatchesSdkAuthorityImport = binding.runtimeIdentity === sdkAuthorityIdentity;
	if (!bindingMatchesSdkAuthorityImport) {
		throw new Error("Store binding runtimeIdentity does not match pinned authority object");
	}
	return {
		bindingMatchesSdkAuthorityImport,
		readingPaths: {
			sdk: "packages/coding-agent/src/sdk.ts → @oh-my-pi/pi-utils/model-request-journal-authority (modelRequestJournalAuthorityRuntimeIdentity)",
			storeBinding:
				"packages/security-audit/src/store/store.ts → withVerifiedModelRequestJournalBinding → binding.runtimeIdentity",
			canonicalModule: "packages/utils/src/model-request-journal-authority.ts (pinned public specifier)",
		},
	};
}

export async function openAuthorityHarness(parentPath: string): Promise<AuthorityHarness> {
	const fixturesHref = pathToFileURL(securityAuditAuthorityFixtures()).href;
	const fixtures = await import(fixturesHref);
	const storeHref = pathToFileURL(securityAuditStoreIndex()).href;
	const writerHref = pathToFileURL(securityAuditWriterModule()).href;
	const storeMod: StoreModule = await import(storeHref);
	const writerMod: WriterModule = await import(writerHref);

	const runtime = storeMod.createSystemRuntime();
	const registry = writerMod.createWriterRegistry({
		runtime,
		attribution: "verified",
		runtimeManifestKind: "test",
		capabilitiesForAgent: () => [],
	});
	const coreWriter = registry.createInternalWriter("harness-core");
	const operatorWriter = registry.createInternalWriter("operator-command");
	const storeRoot = join(parentPath, "store");
	const opened = storeMod.openStore({
		intent: "new",
		storeRoot,
		env: {},
		runtime,
		gates: fixtures.gates(),
		schema: storeMod.STORE_SCHEMA_CHAIN,
		authority: registry,
		initWriter: {
			writerId: operatorWriter.handle.writerId,
			register: tx => {
				operatorWriter.register(tx);
				coreWriter.register(tx);
			},
		},
	});
	if (!opened.ok) {
		throw new Error(`Store open refused: ${opened.failure.code} ${opened.failure.reasonCodes.join(",")}`);
	}
	const store = opened.store;
	return {
		store,
		operator: operatorWriter.handle,
		core: coreWriter.handle,
		storeRoot,
		parentPath,
		close: () => store.close(),
	};
}

export async function writerExclusiveLockPath(storeId: string, writerId: string): Promise<string> {
	return withRawModelRequestJournalLeases({ storeId, control: "shared", maintenance: "shared" }, raw =>
		join(raw.namespacePath, "owners", `${writerId}.lock`),
	);
}
