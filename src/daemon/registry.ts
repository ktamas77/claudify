import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { paths, ensureDirs } from "../shared/paths.js";
import { generateClaudeId } from "../shared/ids.js";
import type { InstanceRecord } from "../shared/types.js";

export interface RegisterArgs {
  session_id: string;
  claude_pid: number;
  cwd: string;
  transcript_path: string;
}

export class Registry {
  private byId = new Map<string, InstanceRecord>();
  private bySession = new Map<string, string>();
  private byClaudePid = new Map<number, string>();

  constructor() {
    this.load();
  }

  list(): InstanceRecord[] {
    return [...this.byId.values()];
  }

  get(claudeId: string): InstanceRecord | undefined {
    return this.byId.get(claudeId);
  }

  getBySession(sessionId: string): InstanceRecord | undefined {
    const id = this.bySession.get(sessionId);
    return id ? this.byId.get(id) : undefined;
  }

  getByClaudePid(pid: number): InstanceRecord | undefined {
    const id = this.byClaudePid.get(pid);
    return id ? this.byId.get(id) : undefined;
  }

  register(args: RegisterArgs): InstanceRecord {
    const existing = this.bySession.get(args.session_id);
    if (existing !== undefined) {
      const rec = this.byId.get(existing);
      if (rec) {
        rec.last_active = nowIso();
        rec.claude_pid = args.claude_pid;
        rec.cwd = args.cwd;
        rec.transcript_path = args.transcript_path;
        this.byClaudePid.set(args.claude_pid, existing);
        this.persist();
        this.writeSessionFile(rec);
        return rec;
      }
    }
    const claudeId = this.uniqueId();
    const rec: InstanceRecord = {
      claude_id: claudeId,
      session_id: args.session_id,
      claude_pid: args.claude_pid,
      cwd: args.cwd,
      transcript_path: args.transcript_path,
      started_at: nowIso(),
      last_active: nowIso(),
      pending_count: 0,
    };
    this.byId.set(claudeId, rec);
    this.bySession.set(args.session_id, claudeId);
    this.byClaudePid.set(args.claude_pid, claudeId);
    this.persist();
    this.writeSessionFile(rec);
    return rec;
  }

  unregister(claudeId: string): boolean {
    const rec = this.byId.get(claudeId);
    if (!rec) return false;
    this.byId.delete(claudeId);
    this.bySession.delete(rec.session_id);
    this.byClaudePid.delete(rec.claude_pid);
    this.removeSessionFile(rec.session_id);
    this.persist();
    return true;
  }

  touch(claudeId: string): void {
    const rec = this.byId.get(claudeId);
    if (!rec) return;
    rec.last_active = nowIso();
    this.persist();
  }

  setPendingCount(claudeId: string, count: number): void {
    const rec = this.byId.get(claudeId);
    if (!rec) return;
    rec.pending_count = count;
    this.persist();
    this.writeSessionFile(rec);
  }

  private uniqueId(): string {
    for (let i = 0; i < 64; i++) {
      const id = generateClaudeId();
      if (!this.byId.has(id)) return id;
    }
    throw new Error("could not generate unique claude_id");
  }

  private load(): void {
    ensureDirs();
    if (!existsSync(paths.registry)) return;
    try {
      const raw = readFileSync(paths.registry, "utf8");
      const parsed = JSON.parse(raw) as { instances: InstanceRecord[] };
      for (const rec of parsed.instances ?? []) {
        this.byId.set(rec.claude_id, rec);
        this.bySession.set(rec.session_id, rec.claude_id);
        this.byClaudePid.set(rec.claude_pid, rec.claude_id);
      }
    } catch {
      // ignore corrupt registry, start fresh
    }
  }

  private persist(): void {
    ensureDirs();
    const tmp = paths.registry + ".tmp";
    const data = JSON.stringify({ instances: this.list() }, null, 2);
    writeFileSync(tmp, data + "\n", "utf8");
    renameSync(tmp, paths.registry);
  }

  private writeSessionFile(rec: InstanceRecord): void {
    const tmp = paths.sessionFile(rec.session_id) + ".tmp";
    const data = JSON.stringify({
      claude_id: rec.claude_id,
      session_id: rec.session_id,
      cwd: rec.cwd,
      transcript_path: rec.transcript_path,
      pending_count: rec.pending_count,
    });
    writeFileSync(tmp, data, "utf8");
    renameSync(tmp, paths.sessionFile(rec.session_id));
  }

  private removeSessionFile(sessionId: string): void {
    const file = paths.sessionFile(sessionId);
    if (existsSync(file)) {
      try {
        unlinkSync(file);
      } catch {
        // best effort
      }
    }
  }
}

function nowIso(): string {
  return new Date().toISOString();
}
