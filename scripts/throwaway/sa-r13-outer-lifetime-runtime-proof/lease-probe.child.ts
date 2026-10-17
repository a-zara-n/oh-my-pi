// Native SQLite selection must precede every other application module.
import "../../audit-library-bootstrap";
import * as path from "node:path";
import { tryAcquireRawModelRequestJournalFileLease } from "@oh-my-pi/pi-utils/model-request-journal-leases";

function emit(payload: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(payload)}\n`);
}

const lockPath = process.argv[2];
const mode = process.argv[3] === "shared" ? "shared" : "exclusive";
if (!lockPath || !path.isAbsolute(lockPath)) {
	emit({ ok: false, error: { name: "ProbeArgumentError", message: "absolute lock path required" } });
	process.exit(2);
}

const uid = process.getuid?.();
if (uid === undefined) {
	emit({ ok: false, error: { name: "ProbeEnvironmentError", message: "getuid unavailable" } });
	process.exit(2);
}

const handle = tryAcquireRawModelRequestJournalFileLease(lockPath, mode, uid);
try {
	emit({
		ok: true,
		lockPath,
		mode,
		acquired: handle !== undefined,
	});
} finally {
	handle?.release();
}
