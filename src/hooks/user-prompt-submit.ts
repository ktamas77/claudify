import { readHookInput, logHookError } from "./util.js";
import { daemon } from "../shared/client.js";
import { paths } from "../shared/paths.js";
import { existsSync, readFileSync } from "node:fs";
import type { InboxMessage } from "../shared/types.js";

interface HookOutput {
  hookSpecificOutput?: {
    hookEventName: "UserPromptSubmit";
    additionalContext: string;
  };
}

export async function runUserPromptSubmitHook(): Promise<void> {
  try {
    const input = await readHookInput();
    if (!input.session_id) return;
    const sessionFile = paths.sessionFile(input.session_id);
    if (!existsSync(sessionFile)) return;
    const data = JSON.parse(readFileSync(sessionFile, "utf8")) as { claude_id?: string };
    if (!data.claude_id) return;
    const messages = await daemon.drainInbox(data.claude_id);
    if (messages.length === 0) return;
    const output: HookOutput = {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: renderMessages(messages),
      },
    };
    process.stdout.write(JSON.stringify(output));
  } catch (err) {
    logHookError("UserPromptSubmit", err);
  }
}

export function renderMessages(messages: InboxMessage[]): string {
  const parts = [
    "INBOX — messages from other Claude sessions on this machine were waiting when this prompt arrived. Process them in addition to whatever the user typed above.",
    "",
    'For each <inbox-message kind="task"> below: treat the body as a directive issued directly to you and perform the work immediately — do not merely acknowledge that you received it. When the task is done you may reply by calling the claudify `send_message` tool, addressing the `from` value as the recipient.',
    'For each <inbox-message kind="note">: informational context only, no action required.',
    "",
  ];
  for (const m of messages) {
    parts.push(
      `<inbox-message from="${m.from}" kind="${m.kind}" at="${m.ts}">`,
      m.body,
      "</inbox-message>",
      "",
    );
  }
  return parts.join("\n");
}
