import { daemon, DaemonError } from "../shared/client.js";
import { readDaemonPid } from "../shared/daemon-spawn.js";
import { isAlive } from "../daemon/liveness.js";
import { paths } from "../shared/paths.js";

export async function runStatus(): Promise<void> {
  const pid = readDaemonPid();
  const pidAlive = pid !== null && isAlive(pid);
  let healthy = false;
  let instances = 0;
  try {
    const h = await daemon.health({ timeoutMs: 250 });
    healthy = h.ok === true;
    instances = h.instances;
  } catch (err) {
    if (!(err instanceof DaemonError)) throw err;
  }
  console.log(
    JSON.stringify(
      {
        daemon_pid: pid,
        daemon_pid_alive: pidAlive,
        daemon_healthy: healthy,
        instances,
        root: paths.root,
      },
      null,
      2,
    ),
  );
}
