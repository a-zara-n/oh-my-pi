import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { integrationRoot } from "./paths.ts";

const UTILS_ROOT = path.join(integrationRoot(), "packages/utils/src");

/** Exact public journal surfaces only; all other @oh-my-pi/pi-utils specifiers use the default resolver. */
const PINNED_SPECIFIER_PATHS: Record<string, string> = {
	"@oh-my-pi/pi-utils": path.join(UTILS_ROOT, "index.ts"),
	"@oh-my-pi/pi-utils/model-request-journal-authority": path.join(UTILS_ROOT, "model-request-journal-authority.ts"),
	"@oh-my-pi/pi-utils/model-request-journal-composition": path.join(UTILS_ROOT, "model-request-journal-composition.ts"),
	"@oh-my-pi/pi-utils/model-request-journal-leases": path.join(UTILS_ROOT, "model-request-journal-leases.ts"),
};

let installed = false;

export function installExactPublicPins(): void {
	if (installed) return;
	installed = true;
	Bun.plugin({
		name: "sa-r13-outer-lifetime-exact-public-pins",
		setup(build) {
			build.onResolve({ filter: /^@oh-my-pi\/pi-utils(\/.*)?$/ }, args => {
				const resolved = PINNED_SPECIFIER_PATHS[args.path];
				if (resolved === undefined || !fs.existsSync(resolved)) return undefined;
				return { path: resolved };
			});
		},
	});
}

export interface PublicPinAssertion {
	readonly runtimeIdentitySameObject: boolean;
	readonly authorityModulePath: string;
	readonly pinnedSpecifiers: readonly string[];
}

/** Load pinned authority/composition before SDK/Store static graph (worker only). */
export async function preloadPinnedJournalModules(): Promise<void> {
	await import("@oh-my-pi/pi-utils/model-request-journal-authority");
	await import("@oh-my-pi/pi-utils/model-request-journal-composition");
}

export async function assertAuthorityCompositionRuntimeIdentity(): Promise<PublicPinAssertion> {
	const authorityPath = path.join(UTILS_ROOT, "model-request-journal-authority.ts");
	const compositionPath = path.join(UTILS_ROOT, "model-request-journal-composition.ts");
	const authorityHref = pathToFileURL(authorityPath).href;
	const compositionHref = pathToFileURL(compositionPath).href;
	const authorityFile = await import(authorityHref);
	const authorityPinned = await import("@oh-my-pi/pi-utils/model-request-journal-authority");
	await import(compositionHref);
	const authorityAfterComposition = await import("@oh-my-pi/pi-utils/model-request-journal-authority");
	const identity = authorityFile.modelRequestJournalAuthorityRuntimeIdentity;
	if (
		identity !== authorityPinned.modelRequestJournalAuthorityRuntimeIdentity ||
		identity !== authorityAfterComposition.modelRequestJournalAuthorityRuntimeIdentity
	) {
		throw new Error("Pinned authority/composition runtimeIdentity objects diverged");
	}
	return {
		runtimeIdentitySameObject: true,
		authorityModulePath: authorityPath,
		pinnedSpecifiers: Object.keys(PINNED_SPECIFIER_PATHS),
	};
}
