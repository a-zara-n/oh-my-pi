import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";

export interface StartupTrace {
	useEntered: boolean;
	useReturned: boolean;
	sdkAssigned: boolean;
	sdkFulfilled: boolean;
	sdkRejected: boolean;
	bindingFulfilled: boolean;
	bindingRejected: boolean;
}

export interface StartupObservers {
	readonly trace: StartupTrace;
	markUseEntered(): void;
	markUseReturned(): void;
	attachSdkStartup(promise: Promise<CreateAgentSessionResult>): void;
	attachBindingJoin(promise: Promise<unknown>): void;
	waitForUseReturned(): Promise<void>;
}

export function createStartupObservers(): StartupObservers {
	const useReturned = Promise.withResolvers<void>();
	const trace: StartupTrace = {
		useEntered: false,
		useReturned: false,
		sdkAssigned: false,
		sdkFulfilled: false,
		sdkRejected: false,
		bindingFulfilled: false,
		bindingRejected: false,
	};
	const releaseUseReturned = (error?: unknown): void => {
		if (trace.useReturned) return;
		trace.useReturned = true;
		if (error !== undefined) useReturned.reject(error);
		else useReturned.resolve();
	};
	return {
		trace,
		markUseEntered() {
			trace.useEntered = true;
		},
		markUseReturned() {
			releaseUseReturned();
		},
		attachSdkStartup(promise) {
			trace.sdkAssigned = true;
			void promise.then(
				() => {
					trace.sdkFulfilled = true;
					if (trace.useEntered && !trace.useReturned) {
						releaseUseReturned(new Error("SDK fulfilled before use returned"));
					}
				},
				() => {
					trace.sdkRejected = true;
				},
			);
		},
		attachBindingJoin(promise) {
			void promise.then(
				() => {
					trace.bindingFulfilled = true;
					if (!trace.useEntered) {
						releaseUseReturned(new Error("binding fulfilled before use entered"));
					}
				},
				error => {
					trace.bindingRejected = true;
					if (!trace.useReturned) {
						releaseUseReturned(error);
					}
				},
			);
		},
		waitForUseReturned: () => useReturned.promise,
	};
}

export function bindingUnsettledAfterUseReturn(trace: StartupTrace): boolean {
	return trace.useReturned && !trace.bindingFulfilled && !trace.bindingRejected;
}

export function sdkUnsettledAfterUseReturn(trace: StartupTrace): boolean {
	return trace.sdkAssigned && !trace.sdkFulfilled && !trace.sdkRejected;
}
