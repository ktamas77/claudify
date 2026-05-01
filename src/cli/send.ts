import { daemon } from "../shared/client.js";
import { ensureDaemonRunning } from "../shared/daemon-spawn.js";
import type { MessageKind } from "../shared/types.js";

export async function runSend(args: string[]): Promise<void> {
  const id = args[0];
  const rest = args.slice(1);
  let kind: MessageKind = "task";
  const bodyParts: string[] = [];
  let from = "cli";
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--note") {
      kind = "note";
    } else if (arg === "--task") {
      kind = "task";
    } else if (arg === "--from") {
      from = rest[++i] ?? from;
    } else {
      bodyParts.push(arg);
    }
  }
  const body = bodyParts.join(" ").trim();
  if (!id || !body) {
    console.error("usage: claudify send <id> <message...> [--note] [--from <id>]");
    process.exitCode = 2;
    return;
  }
  await ensureDaemonRunning();
  const result = await daemon.sendMessage(id, { from, body, kind });
  console.log(`delivered: ${result.id} (kind=${kind})`);
}
