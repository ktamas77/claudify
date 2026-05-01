import { readHookInput, logHookError } from "./util.js";
import { daemon } from "../shared/client.js";
import { paths } from "../shared/paths.js";
import { existsSync, readFileSync } from "node:fs";

export async function runSessionEndHook(): Promise<void> {
  try {
    const input = await readHookInput();
    if (!input.session_id) return;
    const sessionFile = paths.sessionFile(input.session_id);
    if (!existsSync(sessionFile)) return;
    const data = JSON.parse(readFileSync(sessionFile, "utf8")) as { claude_id?: string };
    if (data.claude_id) {
      await daemon.unregister(data.claude_id);
    }
  } catch (err) {
    logHookError("SessionEnd", err);
  }
}
