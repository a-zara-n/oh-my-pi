/**
 * Links a recovery's re-issued model request to the request it follows.
 *
 * A recovery (automatic retry, credential rotation, fallback model, corrective continuation) re-issues the request
 * from a fresh async context, so the transport cannot see the failed attempt on its own. The recovery declares why
 * the next request is a re-attempt; the request path runs each request through {@link ModelRequestReattempts.run},
 * which puts a declared re-attempt on the previous request's retry chain and starts a chain of its own for every
 * other request, so consecutive turns of one prompt never link.
 *
 * @internal
 */
import {
	createModelRequestRetryChain,
	type ModelRequestRetryChain,
	runInModelRequestRetryChain,
} from "@oh-my-pi/pi-ai/model-request-execution";
import type { ModelRequestReason } from "@oh-my-pi/pi-ai/model-request-gate";

export class ModelRequestReattempts {
	#chain: ModelRequestRetryChain | undefined;
	#pending: { reason: ModelRequestReason; epoch: number } | undefined;

	/**
	 * The next request is a re-attempt of the one that just failed. `epoch` names the unit of work the declaration
	 * belongs to (a prompt generation); a request made under another epoch is not a re-attempt of it.
	 */
	declare(reason: ModelRequestReason, epoch = 0): void {
		this.#pending = { reason, epoch };
	}

	/** Drop a declaration whose re-attempt will not be made. */
	clear(): void {
		this.#pending = undefined;
	}

	/** Run one model request, as a declared re-attempt when one is pending for `epoch`. */
	run<T>(fn: () => T, epoch = 0): T {
		const pending = this.#pending;
		this.#pending = undefined;
		let chain = this.#chain;
		let reason: ModelRequestReason | undefined;
		if (pending !== undefined && chain !== undefined && pending.epoch === epoch) {
			reason = pending.reason;
		} else {
			chain = createModelRequestRetryChain();
		}
		this.#chain = chain;
		return runInModelRequestRetryChain(chain, reason, fn);
	}
}
