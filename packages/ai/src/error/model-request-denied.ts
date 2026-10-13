import { attach, create, Flag } from "./flags";

/**
 * A registered ModelRequestGate refused to let a request leave the process.
 *
 * Terminal by construction: it carries {@link Flag.ModelRequestDenied}, which
 * the shared classifiers treat as exclusive, so credential rotation, provider
 * backoff, oneshot retry, turn retry, model fallback and judge-candidate
 * fallback all stop on it. `retryable` is the typed mirror of that flag for
 * callers that hold the error object directly.
 */
export class ModelRequestDeniedError extends Error {
	readonly code: string;
	readonly retryable = false as const;

	constructor(code: string, message: string, options?: { cause?: unknown }) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ModelRequestDeniedError";
		this.code = code;
		attach(this, create(Flag.ModelRequestDenied));
	}
}
