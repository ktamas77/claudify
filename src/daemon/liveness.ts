import type { Registry } from "./registry.js";

const SWEEP_INTERVAL_MS = 10_000;

export function startLivenessSweep(registry: Registry): NodeJS.Timeout {
  const sweep = (): void => {
    for (const rec of registry.list()) {
      if (!isAlive(rec.claude_pid)) {
        registry.unregister(rec.claude_id);
      }
    }
  };
  return setInterval(sweep, SWEEP_INTERVAL_MS);
}

export function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we can't signal it — still alive.
    return code === "EPERM";
  }
}
