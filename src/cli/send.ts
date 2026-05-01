import { daemon } from "../shared/client.js";
import { ensureDaemonRunning } from "../shared/daemon-spawn.js";
import { resolveTargetId } from "../shared/resolve.js";
import type { MessageKind } from "../shared/types.js";

export async function runSend(args: string[]): Promise<void> {
  const target = args[0];
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
  if (!target || !body) {
    console.error("usage: claudemesh send <id-or-folder-name> <message...> [--note] [--from <id>]");
    process.exitCode = 2;
    return;
  }
  await ensureDaemonRunning();
  const claudeId = await resolveTargetId(target);
  const result = await daemon.sendMessage(claudeId, { from, body, kind });
  console.log(`delivered: ${result.id} (to=${claudeId}, kind=${kind})`);
}
