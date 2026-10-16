/**
 * Regression for #15974: a `ControlPath` from the user's ssh_config must win
 * over omp's own socket, so `ssh://` reuses a master the user already
 * authenticated (MFA / keyboard-interactive hosts that `BatchMode=yes` can
 * never reach) instead of trying to start a fresh one.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ptree } from "@oh-my-pi/pi-utils";
import {
	buildRemoteCommand,
	closeConnection,
	ensureConnection,
	getControlPathTemplate,
} from "../../src/ssh/connection-manager";

let binDir: string;
let fakeSsh: string;
let logPath: string;

// Fake `ssh`: `-G` reports a configured ControlPath only for `cfg-host`; the
// "live master" answers `-O check` only when omp left ControlPath to the
// config; starting a new master fails like a keyboard-interactive-only host;
// remote commands run locally so the host probe succeeds.
const FAKE_SSH = `#!/usr/bin/env bash
echo "$*" >> "__LOG__"
case " $* " in
	*" -G "*)
		case "\${!#}" in
			cfg-host) echo "controlpath /tmp/user-master.sock" ;;
			none-host) echo "controlpath none" ;;
		esac
		echo "batchmode no"
		exit 0 ;;
	*" -O check "*)
		case " $* " in *ControlPath=*) exit 255 ;; esac
		echo "Master running" >&2
		exit 0 ;;
	*" -O exit "*) exit 0 ;;
	*" -M "*) echo "Permission denied (keyboard-interactive)." >&2; exit 255 ;;
esac
exec bash -c "\${!#}"
`;

beforeAll(async () => {
	binDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ssh-control-path-"));
	fakeSsh = path.join(binDir, "ssh");
	logPath = path.join(binDir, "calls.log");
	await fs.writeFile(fakeSsh, FAKE_SSH.replace("__LOG__", logPath), { mode: 0o755 });
	await Bun.write(logPath, "");
});

afterAll(async () => {
	await fs.rm(binDir, { recursive: true, force: true });
});

beforeEach(() => {
	const realExec = ptree.exec;
	vi.spyOn(ptree, "exec").mockImplementation((cmd, options) =>
		realExec(cmd[0] === "ssh" ? [fakeSsh, ...cmd.slice(1)] : cmd, options),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe.skipIf(process.platform === "win32")("ssh_config ControlPath (#15974)", () => {
	it("reuses the master at the configured ControlPath and leaves it running on close", async () => {
		const host = { name: "omp-test-15974-cfg-host", host: "cfg-host" };
		await ensureConnection(host);
		const args = await buildRemoteCommand(host, "true");
		await closeConnection(host.name);

		const calls = (await Bun.file(logPath).text()).trim().split("\n");
		expect(calls.some(call => call.includes("-O check") && !call.includes("ControlPath="))).toBe(true);
		expect(calls.some(call => call.startsWith("-M "))).toBe(false);
		expect(calls.some(call => call.includes("-O exit"))).toBe(false);
		expect(args.some(arg => arg.startsWith("ControlPath="))).toBe(false);
		expect(args).toContain("BatchMode=yes");
	});

	it("keeps omp's socket when ssh_config sets no ControlPath or `none`", async () => {
		for (const name of ["plain-host", "none-host"]) {
			const args = await buildRemoteCommand({ name, host: name }, "true", { platform: "linux" });
			expect(args).toContain(`ControlPath=${getControlPathTemplate()}`);
		}
	});
});
