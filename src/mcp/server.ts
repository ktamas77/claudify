import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { daemon, DaemonError } from "../shared/client.js";
import { ensureDaemonRunning } from "../shared/daemon-spawn.js";
import type { MessageKind } from "../shared/types.js";

const TOOLS: Tool[] = [
  {
    name: "whoami",
    description: "Return this Claude session's claudify id, cwd, and start time.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "list_instances",
    description:
      "List all live Claude sessions on this machine: id, cwd, last_active, pending_count.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "send_message",
    description:
      'Send a message to another Claude session. kind="task" (default) wakes an idle recipient; kind="note" surfaces silently on the recipient\'s next prompt.',
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient claude_id (8 chars)" },
        body: { type: "string", description: "Message body" },
        kind: { type: "string", enum: ["task", "note"], default: "task" },
      },
      required: ["to", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "read_inbox",
    description:
      "Pull pending messages addressed to the current session. Drains by default; pass drain=false to peek without removing.",
    inputSchema: {
      type: "object",
      properties: {
        drain: { type: "boolean", default: true },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_history",
    description:
      "Read recent turns from another Claude session's transcript. Redacted by default (large content truncated); set redact=false for raw.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        last_n_turns: { type: "number", default: 20 },
        redact: { type: "boolean", default: true },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "search_history",
    description:
      "Substring or regex search over another Claude session's transcript. Wrap query in /…/flags for regex. Returns matching turns with surrounding context.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        query: { type: "string" },
        context: { type: "number", default: 1 },
      },
      required: ["id", "query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_turn",
    description:
      "Fetch one specific turn (by index) from another Claude session's transcript, full content, no redaction.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        turn_index: { type: "number" },
      },
      required: ["id", "turn_index"],
      additionalProperties: false,
    },
  },
];

interface SelfRef {
  claude_id: string;
}

let cachedSelf: SelfRef | null = null;

async function resolveSelf(): Promise<SelfRef> {
  if (cachedSelf) return cachedSelf;
  await ensureDaemonRunning();
  const ppid = process.ppid;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const rec = await daemon.byPid(ppid, { timeoutMs: 500 });
      cachedSelf = { claude_id: rec.claude_id };
      return cachedSelf;
    } catch (err) {
      if (err instanceof DaemonError && err.status === 404) {
        await sleep(100);
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    `claudify could not resolve its own session via parent pid ${ppid}. Is the SessionStart hook installed?`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ok(data: unknown): { content: [{ type: "text"; text: string }] } {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

function fail(message: string): {
  content: [{ type: "text"; text: string }];
  isError: true;
} {
  return { content: [{ type: "text", text: message }], isError: true };
}

export async function runMcpServer(): Promise<void> {
  const server = new Server(
    { name: "claudify", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => {
    return Promise.resolve({ tools: TOOLS });
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: argsRaw } = req.params;
    const args = (argsRaw ?? {}) as Record<string, unknown>;

    try {
      switch (name) {
        case "whoami": {
          const self = await resolveSelf();
          const rec = await daemon.get(self.claude_id);
          return ok(rec);
        }
        case "list_instances": {
          const self = await resolveSelf();
          const all = await daemon.list();
          return ok(
            all
              .filter((r) => r.claude_id !== self.claude_id)
              .concat(
                all
                  .filter((r) => r.claude_id === self.claude_id)
                  .map((r) => ({ ...r, self: true })),
              ),
          );
        }
        case "send_message": {
          const self = await resolveSelf();
          const to = String(args.to ?? "");
          const body = String(args.body ?? "");
          const kind = (args.kind as MessageKind | undefined) ?? "task";
          if (!to || !body) return fail("`to` and `body` are required");
          if (to === self.claude_id) return fail("cannot send_message to yourself");
          try {
            const result = await daemon.sendMessage(to, { from: self.claude_id, body, kind });
            return ok({ delivered: true, message_id: result.id, to, kind });
          } catch (err) {
            if (err instanceof DaemonError && err.status === 404) {
              const live = await daemon.list();
              return fail(
                `unknown claude_id: ${to}. Live ids: ${live.map((r) => r.claude_id).join(", ")}`,
              );
            }
            throw err;
          }
        }
        case "read_inbox": {
          const self = await resolveSelf();
          const drain = args.drain !== false;
          const messages = drain
            ? await daemon.drainInbox(self.claude_id)
            : await daemon.peekInbox(self.claude_id);
          return ok({ count: messages.length, messages });
        }
        case "read_history": {
          const id = String(args.id ?? "");
          if (!id) return fail("`id` required");
          const params: { last_n_turns?: number; redact?: boolean } = {};
          if (typeof args.last_n_turns === "number") params.last_n_turns = args.last_n_turns;
          else params.last_n_turns = 20;
          if (typeof args.redact === "boolean") params.redact = args.redact;
          const result = await daemon.history(id, params);
          return ok(result);
        }
        case "search_history": {
          const id = String(args.id ?? "");
          const query = String(args.query ?? "");
          if (!id || !query) return fail("`id` and `query` required");
          const params: { context?: number } = {};
          if (typeof args.context === "number") params.context = args.context;
          const result = await daemon.search(id, query, params);
          return ok(result);
        }
        case "get_turn": {
          const id = String(args.id ?? "");
          const turnIndex = Number(args.turn_index);
          if (!id || !Number.isFinite(turnIndex)) return fail("`id` and `turn_index` required");
          const result = await daemon.getTurn(id, turnIndex);
          return ok(result);
        }
        default:
          return fail(`unknown tool: ${name}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(`tool error: ${msg}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
