import { daemon } from "../shared/client.js";
import { ensureDaemonRunning } from "../shared/daemon-spawn.js";

export async function runHistory(args: string[]): Promise<void> {
  const id = args[0];
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
  if (!id) {
    console.error("usage: claudify history <id> [-n N] [--raw]");
    process.exitCode = 2;
    return;
  }
  await ensureDaemonRunning();
  const result = await daemon.history(id, { last_n_turns: lastN, redact });
  console.log(JSON.stringify(result, null, 2));
}
