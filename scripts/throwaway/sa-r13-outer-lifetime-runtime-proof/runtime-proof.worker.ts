/**
 * Isolated worker: allowlisted env only, exact public pins, then one smoke case.
 * Launched exclusively via audit-library-bootstrap from runtime-proof.launcher.ts.
 */
import { applyWorkerEnvFromProcess } from "./env.ts";
import {
	assertAuthorityCompositionRuntimeIdentity,
	installExactPublicPins,
	preloadPinnedJournalModules,
} from "./install-public-pins.ts";

applyWorkerEnvFromProcess();
installExactPublicPins();
await preloadPinnedJournalModules();
await import("./runtime-proof.main.ts");
