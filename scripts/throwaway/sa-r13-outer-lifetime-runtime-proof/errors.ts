export function describeError(error: unknown): Record<string, unknown> {
	if (!(error instanceof Error)) return { thrown: String(error) };
	const out: Record<string, unknown> = {
		name: error.name,
		message: error.message,
	};
	if (error instanceof AggregateError) {
		out.errors = error.errors.map(describeError);
	}
	if (error.cause !== undefined) out.cause = describeError(error.cause);
	return out;
}

/** Walk error identity, AggregateError.errors, and Error.cause for the original failure. */
export function errorChainIncludes(error: unknown, target: Error): boolean {
	const seen = new Set<unknown>();
	let current: unknown = error;
	while (current !== undefined && !seen.has(current)) {
		seen.add(current);
		if (current === target) return true;
		if (current instanceof AggregateError) {
			for (const nested of current.errors) {
				if (errorChainIncludes(nested, target)) return true;
			}
		}
		if (current instanceof Error && current.cause !== undefined) {
			current = current.cause;
			continue;
		}
		break;
	}
	return false;
}
