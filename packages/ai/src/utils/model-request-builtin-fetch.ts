/**
 * The audit bootstrap evaluates this dependency-free leaf before the application graph.
 * Its reference identity, not a function's name/source or a caller's claim, identifies
 * the builtin dispatch target. Importing it never initializes SQLite or an SDK.
 *
 * Trusted startup is a precondition: this does not sandbox JavaScript that already
 * ran before the bootstrap or prevent hostile code from making unrelated I/O.
 * @internal
 */
import type { FetchImpl } from "../types";

/** The actual builtin captured once by the canonical module, never resolved at dispatch. */
export const modelRequestBuiltinFetch: FetchImpl = globalThis.fetch;
const identity = Object.freeze({});
const identityKey = Symbol.for("omp.modelRequestBuiltinFetch.identity.v1");
if (Object.getOwnPropertyDescriptor(globalThis, identityKey) === undefined) {
	Object.defineProperty(globalThis, identityKey, { value: identity, configurable: false, writable: false });
}

/** Reject a custom fetch, a later global replacement, and a separately evaluated copy. */
export function assertModelRequestBuiltinFetch(candidate: FetchImpl | undefined): void {
	const canonical = Object.getOwnPropertyDescriptor(globalThis, identityKey);
	const current = Object.getOwnPropertyDescriptor(globalThis, "fetch");
	if (canonical?.value !== identity || current?.value !== modelRequestBuiltinFetch || candidate !== modelRequestBuiltinFetch) {
		throw new TypeError("required model request transport is not the canonical startup builtin fetch");
	}
}
