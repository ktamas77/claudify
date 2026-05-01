import { daemon, DaemonError } from "../shared/client.js";
import { ensureDaemonRunning } from "../shared/daemon-spawn.js";

export async function runWhoami(): Promise<void> {
  await ensureDaemonRunning();
  const ppid = process.ppid;
  try {
    const rec = await daemon.byPid(ppid);
    console.log(JSON.stringify(rec, null, 2));
  } catch (err) {
    if (err instanceof DaemonError && err.status === 404) {
      console.error(
        `no Claude session registered for parent pid ${ppid}. Are you inside a Claude Code shell?`,
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
