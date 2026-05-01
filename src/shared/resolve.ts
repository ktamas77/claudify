import { basename } from "node:path";
import { daemon } from "./client.js";
import type { InstanceRecord } from "./types.js";

export async function resolveTargetId(idOrName: string): Promise<string> {
  if (!idOrName) throw new Error("expected claude_id or folder name, got empty string");
  const instances = await daemon.list();

  const byId = instances.find((r) => r.claude_id === idOrName);
  if (byId) return byId.claude_id;

  const lowered = idOrName.toLowerCase();
  const byName = instances.filter((r) => basename(r.cwd).toLowerCase() === lowered);
  if (byName.length === 1) return byName[0]!.claude_id;
  if (byName.length > 1) {
    throw new Error(
      `folder name "${idOrName}" matches multiple sessions:\n${formatCandidates(byName)}\nUse the 8-char id to disambiguate.`,
    );
  }

  if (instances.length === 0) {
    throw new Error(`no live claudify sessions registered`);
  }
  throw new Error(
    `no live session matches "${idOrName}". Live sessions:\n${formatCandidates(instances)}`,
  );
}

function formatCandidates(records: InstanceRecord[]): string {
  return records.map((r) => `  ${r.claude_id}  ${basename(r.cwd)}  (${r.cwd})`).join("\n");
}
