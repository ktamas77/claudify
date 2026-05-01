import { daemon } from "../shared/client.js";
import { ensureDaemonRunning } from "../shared/daemon-spawn.js";
import { resolveTargetId } from "../shared/resolve.js";

export async function runHistory(args: string[]): Promise<void> {
  const target = args[0];
  let lastN = 20;
  let redact = true;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-n" || arg === "--last-n-turns") {
      lastN = Number(args[++i]);
    } else if (arg === "--raw") {
      redact = false;
    }
  }
  if (!target) {
    console.error("usage: claudemesh history <id-or-folder-name> [-n N] [--raw]");
    process.exitCode = 2;
    return;
  }
  await ensureDaemonRunning();
  const claudeId = await resolveTargetId(target);
  const result = await daemon.history(claudeId, { last_n_turns: lastN, redact });
  console.log(JSON.stringify(result, null, 2));
}
