import { appendFileSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { paths, ensureDirs } from "../shared/paths.js";
import { generateMessageId } from "../shared/ids.js";
import type { InboxMessage, MessageKind } from "../shared/types.js";

export interface AppendArgs {
  to: string;
  from: string;
  body: string;
  kind?: MessageKind;
}

export class InboxStore {
  append(args: AppendArgs): InboxMessage {
    ensureDirs();
    const msg: InboxMessage = {
      id: generateMessageId(),
      from: args.from,
      to: args.to,
      kind: args.kind ?? "task",
      body: args.body,
      ts: new Date().toISOString(),
    };
    appendFileSync(paths.inboxFile(args.to), JSON.stringify(msg) + "\n", "utf8");
    return msg;
  }

  peek(claudeId: string): InboxMessage[] {
    const file = paths.inboxFile(claudeId);
    if (!existsSync(file)) return [];
    const raw = readFileSync(file, "utf8");
    const out: InboxMessage[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as InboxMessage);
      } catch {
        // skip
      }
    }
    return out;
  }

  drain(claudeId: string): InboxMessage[] {
    const messages = this.peek(claudeId);
    this.clear(claudeId);
    return messages;
  }

  count(claudeId: string): number {
    return this.peek(claudeId).length;
  }

  clear(claudeId: string): void {
    const file = paths.inboxFile(claudeId);
    if (existsSync(file)) {
      try {
        unlinkSync(file);
      } catch {
        // fall back to truncation
        writeFileSync(file, "");
      }
    }
  }
}
