import { readHookInput, logHookError } from "./util.js";
import { daemon } from "../shared/client.js";
import { paths } from "../shared/paths.js";
import { existsSync, readFileSync } from "node:fs";
import type { InboxMessage } from "../shared/types.js";

interface BlockingHookOutput {
  decision: "block";
  reason: string;
}

export async function runStopHook(): Promise<void> {
  try {
    const input = await readHookInput();
    if (!input.session_id) return;
    const sessionFile = paths.sessionFile(input.session_id);
    if (!existsSync(sessionFile)) return;
    const data = JSON.parse(readFileSync(sessionFile, "utf8")) as { claude_id?: string };
    if (!data.claude_id) return;
    const peeked = await daemon.peekInbox(data.claude_id);
    const tasks = peeked.filter((m) => m.kind === "task");
    if (tasks.length === 0) return;
    const drained = await daemon.drainInbox(data.claude_id);
    const output: BlockingHookOutput = {
      decision: "block",
      reason: renderForBlock(drained),
    };
    process.stdout.write(JSON.stringify(output));
  } catch (err) {
    logHookError("Stop", err);
  }
}

function renderForBlock(messages: InboxMessage[]): string {
  const lines = [
    "Inbox messages arrived from other Claude sessions — process them before stopping:",
  ];
  for (const m of messages) {
    lines.push(
      ``,
      `<inbox-message from="${m.from}" kind="${m.kind}" at="${m.ts}">`,
      m.body,
      `</inbox-message>`,
    );
  }
  return lines.join("\n");
}
