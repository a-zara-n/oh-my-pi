import { tryAcquireSessionLease } from "@oh-my-pi/pi-utils/model-request-journal-composition";

const sessionId = process.argv[2];
if (!sessionId) throw new Error("Expected a session ID");
const lease = tryAcquireSessionLease(sessionId);
if (!lease) throw new Error("Unable to acquire the actual session lease");
try {
	console.log("READY");
	for await (const command of console) {
		if (command === "close") break;
	}
} finally {
	lease.release();
}
