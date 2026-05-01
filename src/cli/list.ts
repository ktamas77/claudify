import { daemon } from "../shared/client.js";
import { ensureDaemonRunning } from "../shared/daemon-spawn.js";

export async function runList(): Promise<void> {
  await ensureDaemonRunning();
  const instances = await daemon.list();
  if (instances.length === 0) {
    console.log("(no live Claude sessions)");
    return;
  }
  const rows = instances.map((rec) => ({
    id: rec.claude_id,
    pid: rec.claude_pid,
    cwd: rec.cwd,
    started: rec.started_at,
    pending: rec.pending_count,
  }));
  console.table(rows);
}
