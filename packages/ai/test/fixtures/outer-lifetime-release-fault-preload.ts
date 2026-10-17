/**
 * Test-only fault injection for the `dispatch-sync-throw-joins-response`
 * scenario (DES-004 §6.7.2i E-01 / AC-OL-06). Loaded via `--preload` before
 * the fixture so the ai package's bare-specifier import resolves here first.
 *
 * The wrapper re-exports the REAL composition module unchanged (same absolute
 * file, so every WeakMap stays in the one genuine instance) and wraps exactly
 * one public export: `endJournalSendStart`. The wrapped call runs the real
 * release first, then throws once — only for the first release after a real
 * `beginJournalSend`, i.e. after dispatch actually started. No product guard is
 * bypassed: identity, admission and transport checks all still run against the
 * real modules. The one-shot latch restores pass-through behavior afterwards.
 */
const SPECIFIER = "@oh-my-pi/pi-utils/model-request-journal-composition";

const realPath = import.meta.resolveSync(SPECIFIER);

Bun.plugin({
	name: "outer-lifetime-one-shot-release-fault",
	setup(build) {
		build.module(SPECIFIER, () => ({
			contents: `export * from ${JSON.stringify(realPath)};
import { beginJournalSend as realBegin, endJournalSendStart as realEnd } from ${JSON.stringify(realPath)};
let armed = false;
let thrown = false;
export function beginJournalSend(admission, execution, attempt) {
	const result = realBegin(admission, execution, attempt);
	armed = true;
	return result;
}
export function endJournalSendStart(admission) {
	const result = realEnd(admission);
	if (armed && !thrown) {
		thrown = true;
		throw new Error("sync throw after dispatch started");
	}
	return result;
}`,
			loader: "ts",
		}));
	},
});

