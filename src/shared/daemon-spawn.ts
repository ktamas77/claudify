import { spawn } from "node:child_process";
import { openSync, closeSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { paths, ensureDirs } from "./paths.js";
import { daemon, DaemonError } from "./client.js";

const SPAWN_TIMEOUT_MS = 5000;
const SPAWN_POLL_MS = 50;

export async function ensureDaemonRunning(): Promise<void> {
  if (await isDaemonHealthy()) return;
  spawnDaemon();
  await waitForDaemon();
}

async function isDaemonHealthy(): Promise<boolean> {
  try {
    await daemon.health({ timeoutMs: 250 });
    return true;
  } catch {
    return false;
  }
}

function spawnDaemon(): void {
  ensureDirs();
  const claudifyBin = locateBin();
  const out = openSync(paths.daemonLog, "a");
  const err = openSync(paths.daemonLog, "a");
  const child = spawn(process.execPath, [claudifyBin, "daemon"], {
    detached: true,
    stdio: ["ignore", out, err],
    env: process.env,
  });
  closeSync(out);
  closeSync(err);
  if (child.pid !== undefined) {
    writeFileSync(paths.daemonPid, String(child.pid));
  }
  child.unref();
}

async function waitForDaemon(): Promise<void> {
  const deadline = Date.now() + SPAWN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isDaemonHealthy()) return;
    await sleep(SPAWN_POLL_MS);
  }
  throw new DaemonError("daemon failed to come up within timeout");
}

function locateBin(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "bin", "claudify.js");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function readDaemonPid(): number | null {
  if (!existsSync(paths.daemonPid)) return null;
  const text = readFileSync(paths.daemonPid, "utf8").trim();
  const pid = Number(text);
  return Number.isFinite(pid) ? pid : null;
}
