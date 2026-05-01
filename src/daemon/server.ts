import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Registry } from "./registry.js";
import { InboxStore } from "./inbox.js";
import { startLivenessSweep } from "./liveness.js";
import { loadConfig } from "../shared/config.js";
import { readTranscript, searchTranscript, getTurn } from "../shared/transcript.js";
import type { InstanceRecord, MessageKind } from "../shared/types.js";

interface RouteContext {
  registry: Registry;
  inbox: InboxStore;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  body: unknown;
}

export interface DaemonHandle {
  close(): Promise<void>;
}

export async function startDaemon(): Promise<DaemonHandle> {
  const cfg = loadConfig();
  const registry = new Registry();
  const inbox = new InboxStore();
  syncPendingCounts(registry, inbox);
  const sweepTimer = startLivenessSweep(registry);

  const server = createServer((req, res) => {
    handle(req, res, registry, inbox).catch((err: unknown) => {
      sendJson(res, 500, { error: (err as Error).message });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(cfg.port, cfg.host, () => resolve());
  });

  const onSignal = (signal: NodeJS.Signals): void => {
    console.error(`[claudify-daemon] received ${signal}, shutting down`);
    clearInterval(sweepTimer);
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  console.error(`[claudify-daemon] listening on http://${cfg.host}:${cfg.port}`);

  return {
    close(): Promise<void> {
      clearInterval(sweepTimer);
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  registry: Registry,
  inbox: InboxStore,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const body = await readBody(req);
  const ctx: RouteContext = { registry, inbox, req, res, url, body };

  if (req.method === "GET" && url.pathname === "/healthz") return health(ctx);
  if (req.method === "POST" && url.pathname === "/register") return register(ctx);
  if (req.method === "GET" && url.pathname === "/instances") return list(ctx);

  const instanceMatch = url.pathname.match(/^\/instances\/([a-z0-9]{8})(\/.*)?$/);
  if (instanceMatch) {
    const claudeId = instanceMatch[1]!;
    const sub = instanceMatch[2] ?? "";
    return instanceRoute(ctx, claudeId, sub);
  }

  const pidMatch = url.pathname.match(/^\/by-pid\/(\d+)$/);
  if (pidMatch && req.method === "GET") {
    const pid = Number(pidMatch[1]);
    const rec = registry.getByClaudePid(pid);
    if (!rec) return sendJson(res, 404, { error: "no instance for that pid" });
    return sendJson(res, 200, rec);
  }

  sendJson(res, 404, { error: "not found" });
}

function instanceRoute(ctx: RouteContext, claudeId: string, sub: string): void {
  const { req, res, registry, inbox, body, url } = ctx;
  const rec = registry.get(claudeId);
  if (!rec && req.method !== "DELETE") {
    return sendJson(res, 404, { error: `unknown claude_id: ${claudeId}` });
  }

  if (sub === "" && req.method === "GET") {
    return sendJson(res, 200, rec);
  }
  if (sub === "" && req.method === "DELETE") {
    const removed = registry.unregister(claudeId);
    return sendJson(res, removed ? 200 : 404, { ok: removed });
  }
  if (sub === "/messages" && req.method === "POST") {
    const payload = body as { from?: string; body?: string; kind?: MessageKind };
    if (!payload?.from || !payload?.body) {
      return sendJson(res, 400, { error: "from + body required" });
    }
    const appendArgs: { to: string; from: string; body: string; kind?: MessageKind } = {
      to: claudeId,
      from: payload.from,
      body: payload.body,
    };
    if (payload.kind !== undefined) appendArgs.kind = payload.kind;
    const msg = inbox.append(appendArgs);
    registry.setPendingCount(claudeId, inbox.count(claudeId));
    registry.touch(claudeId);
    return sendJson(res, 200, { id: msg.id });
  }
  if (sub === "/messages" && req.method === "GET") {
    const drain = url.searchParams.get("drain") === "1";
    const messages = drain ? inbox.drain(claudeId) : inbox.peek(claudeId);
    registry.setPendingCount(claudeId, inbox.count(claudeId));
    return sendJson(res, 200, messages);
  }
  if (sub === "/history" && req.method === "GET") {
    const lastN = parseIntOrUndefined(url.searchParams.get("last_n_turns"));
    const redact = url.searchParams.get("redact") !== "false";
    const opts: { lastNTurns?: number; redact?: boolean } = { redact };
    if (lastN !== undefined) opts.lastNTurns = lastN;
    const turns = readTranscript(rec!.transcript_path, opts);
    return sendJson(res, 200, { turns });
  }
  if (sub === "/search" && req.method === "GET") {
    const query = url.searchParams.get("q") ?? "";
    if (!query) return sendJson(res, 400, { error: "q required" });
    const ctxLines = parseIntOrUndefined(url.searchParams.get("context"));
    const opts: { context?: number } = {};
    if (ctxLines !== undefined) opts.context = ctxLines;
    const matches = searchTranscript(rec!.transcript_path, query, opts);
    return sendJson(res, 200, { matches });
  }
  const turnMatch = sub.match(/^\/turn\/(\d+)$/);
  if (turnMatch && req.method === "GET") {
    const idx = Number(turnMatch[1]);
    const turn = getTurn(rec!.transcript_path, idx);
    if (!turn) return sendJson(res, 404, { error: "turn out of range" });
    return sendJson(res, 200, { turn });
  }

  sendJson(res, 405, { error: "method not allowed" });
}

function health(ctx: RouteContext): void {
  sendJson(ctx.res, 200, { ok: true, instances: ctx.registry.list().length });
}

function register(ctx: RouteContext): void {
  const body = ctx.body as Partial<{
    session_id: string;
    claude_pid: number;
    cwd: string;
    transcript_path: string;
  }>;
  if (!body?.session_id || !body?.claude_pid || !body?.cwd || !body?.transcript_path) {
    return sendJson(ctx.res, 400, {
      error: "session_id, claude_pid, cwd, transcript_path required",
    });
  }
  const rec = ctx.registry.register({
    session_id: body.session_id,
    claude_pid: body.claude_pid,
    cwd: body.cwd,
    transcript_path: body.transcript_path,
  });
  sendJson(ctx.res, 200, { claude_id: rec.claude_id, instance: rec });
}

function list(ctx: RouteContext): void {
  sendJson(ctx.res, 200, ctx.registry.list());
}

function syncPendingCounts(registry: Registry, inbox: InboxStore): void {
  for (const rec of registry.list()) {
    registry.setPendingCount(rec.claude_id, inbox.count(rec.claude_id));
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", Buffer.byteLength(text));
  res.end(text);
}

function parseIntOrUndefined(v: string | null): number | undefined {
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export type { InstanceRecord };
