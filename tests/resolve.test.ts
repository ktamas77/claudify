import { describe, expect, it, vi, beforeEach } from "vitest";
import type { InstanceRecord } from "../src/shared/types.js";

const listMock = vi.fn<() => Promise<InstanceRecord[]>>();

vi.mock("../src/shared/client.js", () => ({
  daemon: {
    list: (...args: unknown[]) => listMock(...(args as [])),
  },
}));

import { resolveTargetId } from "../src/shared/resolve.js";

function record(claudeId: string, cwd: string): InstanceRecord {
  return {
    claude_id: claudeId,
    session_id: `s-${claudeId}`,
    claude_pid: 1,
    cwd,
    transcript_path: "",
    started_at: "2026-01-01T00:00:00Z",
    last_active: "2026-01-01T00:00:00Z",
    pending_count: 0,
  };
}

describe("resolveTargetId", () => {
  beforeEach(() => listMock.mockReset());

  it("returns the same id when given a literal claude_id that exists", async () => {
    listMock.mockResolvedValue([
      record("abc12345", "/Users/x/dev/api"),
      record("def67890", "/Users/x/dev/web"),
    ]);
    await expect(resolveTargetId("abc12345")).resolves.toBe("abc12345");
  });

  it("resolves a folder basename to its claude_id", async () => {
    listMock.mockResolvedValue([
      record("abc12345", "/Users/x/dev/api"),
      record("def67890", "/Users/x/dev/web"),
    ]);
    await expect(resolveTargetId("api")).resolves.toBe("abc12345");
  });

  it("matches basenames case-insensitively", async () => {
    listMock.mockResolvedValue([record("abc12345", "/Users/x/dev/Api-Service")]);
    await expect(resolveTargetId("api-service")).resolves.toBe("abc12345");
  });

  it("prefers an exact id match even if the same string is also a folder", async () => {
    // In practice claude_ids are 8 chars from a fixed alphabet, so collision
    // with a folder name is unlikely, but the resolver must still prefer ids.
    listMock.mockResolvedValue([
      record("api", "/Users/x/dev/something-else"),
      record("def67890", "/Users/x/dev/api"),
    ]);
    await expect(resolveTargetId("api")).resolves.toBe("api");
  });

  it("throws when no live session matches the input", async () => {
    listMock.mockResolvedValue([record("abc12345", "/Users/x/dev/api")]);
    await expect(resolveTargetId("nonsense")).rejects.toThrow(/no live session matches/);
  });

  it("throws a different message when there are no live sessions at all", async () => {
    listMock.mockResolvedValue([]);
    await expect(resolveTargetId("anything")).rejects.toThrow(/no live claudify sessions/);
  });

  it("throws with disambiguation when a folder name matches multiple sessions", async () => {
    listMock.mockResolvedValue([
      record("abc12345", "/Users/x/dev/orgA/api"),
      record("def67890", "/Users/x/dev/orgB/api"),
    ]);
    await expect(resolveTargetId("api")).rejects.toThrow(/matches multiple sessions/);
  });

  it("rejects empty input without consulting the daemon", async () => {
    await expect(resolveTargetId("")).rejects.toThrow(/empty string/);
    expect(listMock).not.toHaveBeenCalled();
  });
});
