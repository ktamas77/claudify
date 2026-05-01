import { readHookInput, logHookError } from "./util.js";
import { ensureDaemonRunning } from "../shared/daemon-spawn.js";
import { daemon } from "../shared/client.js";

export async function runSessionStartHook(): Promise<void> {
  try {
    const input = await readHookInput();
    if (!input.session_id || !input.transcript_path) return;
    await ensureDaemonRunning();
    await daemon.register(
      {
        session_id: input.session_id,
        claude_pid: process.ppid,
        cwd: input.cwd ?? process.cwd(),
        transcript_path: input.transcript_path,
      },
      { retry: true },
    );
  } catch (err) {
    logHookError("SessionStart", err);
  }
}
