import { paths } from "../shared/paths.js";
import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "../shared/config.js";
import { daemon } from "../shared/client.js";

interface SessionFile {
  claude_id?: string;
  pending_count?: number;
}

interface StatusLineInput {
  session_id?: string;
}

export async function runStatusLine(): Promise<void> {
  try {
    const input = await readStdin();
    if (!input.session_id) return;
    const sessionFile = paths.sessionFile(input.session_id);
    if (!existsSync(sessionFile)) return;
    const data = JSON.parse(readFileSync(sessionFile, "utf8")) as SessionFile;
    if (!data.claude_id) return;
    const cfg = loadConfig();
    let peers = 0;
    let pending = data.pending_count ?? 0;
    try {
      const all = await daemon.list({ timeoutMs: 250 });
      peers = Math.max(0, all.length - 1);
      const self = all.find((r) => r.claude_id === data.claude_id);
      if (self) pending = self.pending_count;
    } catch {
      // daemon unavailable — fall back to whatever the session file held
    }
    const parts = [data.claude_id];
    if (cfg.statusline.show_peers && peers > 0) parts.push(`${peers} peers`);
    if (cfg.statusline.show_inbox && pending > 0) parts.push(`✉${pending}`);
    process.stdout.write(`[${parts.join(" · ")}]`);
  } catch {
    // never break the prompt
  }
}

async function readStdin(): Promise<StatusLineInput> {
  if (process.stdin.isTTY) return {};
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as StatusLineInput;
  } catch {
    return {};
  }
}
