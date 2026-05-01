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
    if (tasks.length === 0) {
      await daemon.setIdle(data.claude_id, true).catch(() => undefined);
      return;
    }
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

export function renderForBlock(messages: InboxMessage[]): string {
  const lines = [
    "INBOX — messages from other Claude sessions running on this machine. Do not stop yet; act on them now.",
    "",
    'For each <inbox-message kind="task"> below: treat the body as a directive issued directly to you, exactly as if the user had typed it in this session. Perform the work immediately — do not merely acknowledge that you received it. When the task is done you may reply by calling the claudemesh `send_message` tool, addressing the `from` value as the recipient.',
    'For each <inbox-message kind="note">: informational context only, no action required.',
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
