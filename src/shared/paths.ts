import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const ROOT = join(homedir(), ".claudify");

export const paths = {
  root: ROOT,
  registry: join(ROOT, "registry.json"),
  config: join(ROOT, "config.json"),
  daemonPid: join(ROOT, "daemon.pid"),
  daemonLog: join(ROOT, "daemon.log"),
  daemonLock: join(ROOT, "daemon.lock"),
  sessionsDir: join(ROOT, "sessions"),
  inboxDir: join(ROOT, "inbox"),
  sessionFile(sessionId: string): string {
    return join(ROOT, "sessions", `${sessionId}.json`);
  },
  inboxFile(claudeId: string): string {
    return join(ROOT, "inbox", `${claudeId}.jsonl`);
  },
} as const;

export function ensureDirs(): void {
  mkdirSync(ROOT, { recursive: true });
  mkdirSync(paths.sessionsDir, { recursive: true });
  mkdirSync(paths.inboxDir, { recursive: true });
}
