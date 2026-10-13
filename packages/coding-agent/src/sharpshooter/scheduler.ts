import { bindModelRequestExecution } from "@oh-my-pi/pi-ai/model-request-execution";
import { logger } from "@oh-my-pi/pi-utils";

import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { runSharpshooterConsolidation } from "./consolidate";
import { readSharpshooterState, sharpshooterBankDir } from "./paths";
import { sharpshooterQueueDepth } from "./queue";

import { cfgSharpshooterIntervalMinutes } from "./settings";

const SCHEDULER_TICK_MS = 60_000;

interface SchedulerOptions {
	agentDir: string;
	cwd: string;
	settings: Settings;
	modelRegistry: ModelRegistry;
	sessionId: string;
}

/** One session's claim on a bank's shared interval, with the work it runs bound to that session's context. */
interface SchedulerHolder {
	readonly tick: () => Promise<void>;
}

interface SchedulerEntry {
	timer: NodeJS.Timeout;
	/** Live holders in registration order; the interval works for the oldest one that is still alive. */
	holders: SchedulerHolder[];
}

const schedulers = new Map<string, SchedulerEntry>();

function createHolder(options: SchedulerOptions): SchedulerHolder {
	// Bound where the session registers: a timer fires in its own context, not the registering session's.
	const tick = bindModelRequestExecution(async (): Promise<void> => {
		try {
			const [depth, state] = await Promise.all([
				sharpshooterQueueDepth(options.agentDir, options.cwd),
				readSharpshooterState(options.agentDir, options.cwd),
			]);
			const intervalMinutes = cfgSharpshooterIntervalMinutes.get(options.settings);
			const due = Date.now() - state.lastConsolidatedAt >= intervalMinutes * 60_000;
			if (depth === 0 && !due) return;
			await runSharpshooterConsolidation(options);
		} catch (error) {
			logger.debug("sharpshooter scheduler tick failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});
	return { tick };
}

export function startSharpshooterScheduler(options: SchedulerOptions): () => void {
	const bankDir = sharpshooterBankDir(options.agentDir, options.cwd);
	const holder = createHolder(options);
	const existing = schedulers.get(bankDir);
	if (existing) {
		existing.holders.push(holder);
		return createDisposer(bankDir, existing, holder);
	}

	// One interval serves every session on this bank. Each tick runs the oldest live holder's work, so a request is
	// attributed to a session that is still alive, never to one that has already been disposed.
	const holders = [holder];
	const timer = setInterval(() => void holders[0]?.tick(), SCHEDULER_TICK_MS);
	timer.unref();
	const entry: SchedulerEntry = { timer, holders };
	schedulers.set(bankDir, entry);
	void holder.tick();
	return createDisposer(bankDir, entry, holder);
}

function createDisposer(bankDir: string, entry: SchedulerEntry, holder: SchedulerHolder): () => void {
	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		if (schedulers.get(bankDir) !== entry) return;
		const index = entry.holders.indexOf(holder);
		if (index >= 0) entry.holders.splice(index, 1);
		if (entry.holders.length > 0) return;
		clearInterval(entry.timer);
		schedulers.delete(bankDir);
	};
}
