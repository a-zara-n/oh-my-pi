import { withRawModelRequestJournalLeases } from "../../src/model-request-journal-leases";

const storeId = process.argv[2];
const registryId = process.argv[3];
if (storeId === undefined) throw new Error("Missing test namespace");
await withRawModelRequestJournalLeases({storeId, control: registryId === undefined ? "exclusive" : "shared", maintenance: "shared", ...(registryId === undefined ? {} : {registryId})}, async raw => {
	raw.assertHeld();
	await Bun.write(Bun.stdout, "held\n");
	await Bun.stdin.text();
});
