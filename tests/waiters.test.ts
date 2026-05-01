import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Waiters } from "../src/daemon/waiters.js";

class FakeRes extends EventEmitter {
  statusCode = 0;
  writableEnded = false;
  destroyed = false;
  headers = new Map<string, string | number>();
  body: string | null = null;

  setHeader(name: string, value: string | number): void {
    this.headers.set(name.toLowerCase(), value);
  }
  end(payload?: string): void {
    if (payload !== undefined) this.body = payload;
    this.writableEnded = true;
  }
  simulateClose(): void {
    this.destroyed = true;
    this.emit("close");
  }
}

function asRes(r: FakeRes): import("node:http").ServerResponse {
  return r as unknown as import("node:http").ServerResponse;
}

describe("Waiters", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves a waiter with 200 + payload when notified", () => {
    const w = new Waiters();
    const r = new FakeRes();
    w.add("abc", asRes(r), 30_000);
    expect(w.count("abc")).toBe(1);

    const woken = w.notify("abc", { type: "message", pending: 1 });
    expect(woken).toBe(1);
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe(JSON.stringify({ type: "message", pending: 1 }));
    expect(w.count("abc")).toBe(0);
  });

  it("resolves a waiter with 204 + empty body when its timeout fires", () => {
    const w = new Waiters();
    const r = new FakeRes();
    w.add("abc", asRes(r), 5_000);
    expect(r.statusCode).toBe(0);

    vi.advanceTimersByTime(5_000);

    expect(r.statusCode).toBe(204);
    expect(r.body).toBeNull();
    expect(w.count("abc")).toBe(0);
  });

  it("does not deliver messages addressed to a different claude_id", () => {
    const w = new Waiters();
    const r = new FakeRes();
    w.add("abc", asRes(r), 30_000);

    const woken = w.notify("xyz", { type: "message", pending: 1 });

    expect(woken).toBe(0);
    expect(r.statusCode).toBe(0);
    expect(w.count("abc")).toBe(1);
  });

  it("removes a waiter when its underlying response closes early", () => {
    const w = new Waiters();
    const r = new FakeRes();
    w.add("abc", asRes(r), 30_000);
    expect(w.count("abc")).toBe(1);

    r.simulateClose();

    expect(w.count("abc")).toBe(0);
    // notify after close should be a no-op (nothing to wake, no error)
    expect(w.notify("abc", { type: "message", pending: 0 })).toBe(0);
  });

  it("notifies multiple waiters for the same claude_id at once", () => {
    const w = new Waiters();
    const a = new FakeRes();
    const b = new FakeRes();
    w.add("abc", asRes(a), 30_000);
    w.add("abc", asRes(b), 30_000);
    expect(w.count("abc")).toBe(2);

    const woken = w.notify("abc", { type: "message", pending: 1 });

    expect(woken).toBe(2);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(w.count("abc")).toBe(0);
  });

  it("closeAll clears every pending waiter and ends their responses", () => {
    const w = new Waiters();
    const a = new FakeRes();
    const b = new FakeRes();
    w.add("abc", asRes(a), 30_000);
    w.add("xyz", asRes(b), 30_000);

    w.closeAll();

    expect(a.writableEnded).toBe(true);
    expect(b.writableEnded).toBe(true);
    expect(w.count("abc")).toBe(0);
    expect(w.count("xyz")).toBe(0);
  });
});
