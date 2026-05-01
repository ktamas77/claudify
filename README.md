# claudify

A local side-channel between [Claude Code](https://claude.com/claude-code) sessions running on the same machine. Each session gets a short ID, can list other live sessions, send them messages, read their conversation history — and, when launched through the `claudify run` supervisor, **wake up and act on incoming messages in realtime, even when fully idle.** No cloud, no network exposure, no auth.

> Status: v0.2 — realtime PTY supervisor + folder-name addressing + idle tracking.

## Why

You probably run `claude` in several folders at once. They have no idea about each other. Claudify gives every session a stable identity and a realtime side channel:

- **List**: which other Claudes are running, where, and for how long.
- **Message**: hand a task to another Claude (`claudify send api-service "rerun the migration check"`) — the recipient acts on it immediately if launched via the supervisor, or on its next turn otherwise.
- **Read**: peek at another instance's history (recent turns, search, fetch a specific turn).
- **Notice**: the receiver's status line ticks up (`✉2`) when messages are waiting.

Everything is purely additive. Normal `claude` flows continue to work unchanged.

## How it works

There are two layers, and you can use either independently:

```
   ┌─────────────── one machine ───────────────┐
   │                                            │
   │  ┌── claudify run (PTY supervisor) ────┐   │  ← Layer 2: realtime injection
   │  │   ↑↓ proxy user terminal ↔ claude  │   │      (optional but recommended)
   │  │   subscribes to daemon /events      │   │
   │  │   writes "[inbox]\n" to PTY master  │   │
   │  └─┬─────────────────────────────────┬─┘   │
   │    │ (PTY pair)                      │     │
   │  ┌─▼──────────────── claude ──────────▼─┐  │  ← Layer 1: hooks + MCP
   │  │   SessionStart/End hooks             │  │      (works with bare `claude` too)
   │  │   UserPromptSubmit hook (drains inbox)│ │
   │  │   Stop hook (blocks on tasks)        │  │
   │  │   MCP server: claudify               │  │
   │  └──────────────────────────────────────┘  │
   │                                            │
   │              ┌─────────────────────────┐   │
   │              │  claudify daemon        │   │
   │              │  HTTP @ 127.0.0.1:7878  │   │
   │              │  • registry + idle flag │   │
   │              │  • inboxes              │   │
   │              │  • events long-poll     │   │
   │              │  • liveness sweep       │   │
   │              └─────────────────────────┘   │
   └────────────────────────────────────────────┘
```

The daemon binds to `127.0.0.1` only. State persists to `~/.claudify/`.

### Realtime via the supervisor

`claudify run` spawns `claude` inside a PTY (via `node-pty`) and proxies your terminal byte-for-byte to/from it — so it looks and feels exactly like running `claude` directly. In parallel it long-polls the daemon for new inbox messages addressed to this session. When one arrives:

1. Wait for the daemon's `idle` flag on this session to be `true` (the `Stop` hook sets it when claude finishes a turn; the `UserPromptSubmit` hook clears it).
2. Wait for ≥500ms of stdin silence (so we don't corrupt typing).
3. Write `[inbox]\n` to the PTY master.

That sentinel is read by claude as if you typed it. `UserPromptSubmit` fires, the hook drains the inbox, and the messages arrive as additional context attached to that turn — with explicit instructions to _act_ on `kind="task"` bodies, not just acknowledge them. End-to-end latency from `send` to claude starting work is sub-second on a healthy machine.

### Without the supervisor (bare `claude`)

If you keep running `claude` directly, the inbox + hooks still do most of the work:

- Messages still queue in the inbox.
- Status line still shows `✉N`.
- The `Stop` hook still blocks on pending tasks if it happens to fire while messages are queued.
- `UserPromptSubmit` still drains messages into the next turn.

What you lose is the **wake-up for fully-idle claude**: messages that arrive after `Stop` has already fired sit in the inbox until you submit any prompt. With the supervisor, that gap goes away.

### Status line

```
[abc12345 · 3 peers · ✉2]
```

- `abc12345` — this session's ID.
- `3 peers` — count of _other_ live Claudes (drops out at zero).
- `✉2` — unread inbox messages (drops out at zero).

## Install

> Requires Node ≥ 20. The supervisor needs `node-pty` (native, prebuilt for darwin/linux/win).

```bash
npm i -g @ktamas77/claudify
claudify install
```

`claudify install` patches two files (each backed up first):

- `~/.claude/settings.json` — adds the four hooks and the status-line script.
- `~/.claude.json` — adds the `claudify` MCP server under `mcpServers`.

For the realtime path, alias `claude` to `claudify run`:

```bash
# in ~/.zshrc or ~/.bashrc
alias claude='claudify run'
```

Then start (or restart) any `claude` session. You'll see your ID in the status line.

```bash
claudify uninstall   # reverses the install
```

If `node-pty` fails to install (older toolchain), `claudify run` errors out with a fix-it message but every other command still works — you just won't get realtime injection.

### Adding the badge to an existing status line

If you already have a custom `statusLine` script in `~/.claude/settings.json`, `claudify install` detects it and **leaves it alone** rather than clobbering your customizations. To add the `[abc12345 · 3 peers · ✉2]` badge yourself, capture stdin once and pipe it to `claudify statusline`:

```bash
#!/bin/bash
input=$(cat)

# ... your existing parts ...
out="$host | $model | $ctx | $folder"

# Claudify badge (only renders if claudify is installed and a session is registered)
if command -v claudify >/dev/null 2>&1; then
  badge=$(printf '%s' "$input" | claudify statusline 2>/dev/null)
  [ -n "$badge" ] && out="$out | $badge"
fi

printf '%s\n' "$out"
```

`claudify statusline` reads the same JSON Claude Code already pipes to your script (it needs `session_id`), prints `[id · peers · ✉N]`, and exits silently with no output if the daemon is down or the session isn't registered yet.

## CLI

```
claudify run [claude args...]          launch claude inside the realtime supervisor
claudify list                          show all live Claude sessions
claudify whoami                        this shell's parent claude (best-effort by ppid)
claudify send <target> <message>       send a task message; target = id or folder name
claudify history <target> [-n N]       tail another session's transcript
claudify search <target> <query>       search another session's transcript
claudify status                        daemon health + instance count
claudify install / uninstall           patch / unpatch ~/.claude config
claudify daemon                        foreground daemon (used by lazy spawn)
claudify mcp                           stdio MCP server (spawned by claude)
claudify hook <event>                  internal: hook handler
claudify statusline                    internal: status-line renderer
```

`CLAUDIFY_CLAUDE_BIN` overrides which binary `claudify run` launches (default: `claude` on PATH). Useful if you want to point at a specific Claude Code build without breaking the alias.

### Addressing sessions: id or folder name

Anywhere a target is expected — CLI commands and MCP tools alike — you can pass either the 8-char `claude_id` or the **basename of that session's working directory**. The resolver:

1. Tries an exact `claude_id` match against the live registry.
2. Falls back to a case-insensitive match on `basename(cwd)`.

```bash
# These two are equivalent when one live session is running in /Users/me/dev/api-service
claudify send 7k3p9q2x "rerun the migration check"
claudify send api-service "rerun the migration check"
```

If the folder name matches more than one live session (e.g. `~/orgA/api` and `~/orgB/api` both running), the resolver errors out with both `claude_id`s and full paths so you can disambiguate by id. If nothing matches, it prints all live sessions.

## MCP tools

The `claudify` MCP server exposes the following inside every `claude` session. Wherever a tool takes a target session, you can pass either an 8-char `claude_id` or a folder basename (see [Addressing sessions](#addressing-sessions-id-or-folder-name)).

| Tool                                       | Purpose                                                                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `whoami`                                   | Your own `claude_id`, cwd, started_at.                                                                                                            |
| `list_instances`                           | All live sessions: id, cwd, last_active, pending count, idle.                                                                                     |
| `send_message(to, body, kind?)`            | Send to another session. `kind: "task"` (default) wakes the recipient via the supervisor / Stop hook; `kind: "note"` is silent until next prompt. |
| `read_inbox(drain?)`                       | Pull pending messages for the current session (defaults to draining).                                                                             |
| `read_history(id, last_n_turns?, redact?)` | Recent turns from another session, redacted by default; pass `redact: false` for raw.                                                             |
| `search_history(id, query, options?)`      | Substring/regex search over another session's transcript with surrounding context.                                                                |
| `get_turn(id, turn_index)`                 | Pinpoint full-content fetch of one turn after `read_history` / `search_history` flagged it.                                                       |

## Message delivery

Two kinds:

- **task** (default) — receiver acts on the body as if you typed it. Three delivery paths, in priority order:
  1. **Supervisor injection (realtime)** — if the receiver is launched via `claudify run`, the supervisor writes `[inbox]\n` into the PTY the moment the message arrives and the receiver is idle + not actively typing. Sub-second wake-up.
  2. **Stop hook (between turns)** — if the receiver is _just finishing_ a turn when the message lands, the `Stop` hook blocks the stop and feeds the message in as the continuation directive.
  3. **UserPromptSubmit (next prompt)** — if neither of the above caught it (no supervisor, fully idle), the message sits in the inbox until the user submits any prompt to that receiver, at which point it's appended as additional context for that turn.
- **note** — surfaces only via path #3 (next prompt). Doesn't block stops, doesn't wake the model.

Inbox is at-least-once and drained on read.

### Idle tracking

The daemon stores an `idle: boolean` per session, kept in sync by the hooks:

- `SessionStart` (or first register) → `idle: false`
- `UserPromptSubmit` (user just submitted) → `idle: false`
- `Stop`, when allowing the stop (no inbox tasks pending) → `idle: true`

The supervisor reads this flag before injecting, ensuring it never types into a session that's mid-turn.

## Privacy & security

- Daemon binds to `127.0.0.1` only — never `0.0.0.0`. Single-user assumption matches the rest of `~/.claude`.
- `read_history` redacts large tool results / file contents above a per-line byte cap by default. Pass `redact: false` (or use `get_turn`) for raw.
- Hooks fail open: any daemon error is logged and the hook exits 0. Claude Code keeps working with no claudify integration if the daemon is down.
- The supervisor never writes to the PTY without (a) idle flag set and (b) ≥500ms stdin silence — so it can't corrupt input you're typing.

## Development

```bash
git clone git@github.com:ktamas77/claudify.git
cd claudify
npm install
npm run build       # tsc → dist/ (also chmod +x the bin)
npm run dev         # tsc --watch
npm run lint        # eslint
npm run format      # prettier --write
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

Pre-commit (husky) runs `typecheck → test → lint-staged`. A broken type or failing test blocks the commit.

### Layout

```
src/
├── bin/claudify.ts          # entrypoint, dispatches all subcommands
├── cli/
│   ├── run.ts               # PTY supervisor (claudify run)
│   ├── send.ts, history.ts, search.ts, list.ts, whoami.ts, status.ts
│   ├── install.ts, statusline.ts
│   └── ...
├── daemon/
│   ├── server.ts            # HTTP routes incl. /events long-poll, PATCH idle
│   ├── registry.ts          # id ↔ session ↔ pid ↔ cwd, idle flag
│   ├── inbox.ts             # per-recipient jsonl
│   ├── waiters.ts           # pub-sub for the events long-poll
│   └── liveness.ts          # prune dead PIDs
├── mcp/server.ts            # stdio MCP server
├── hooks/                   # session-start, session-end, user-prompt-submit, stop
└── shared/                  # paths, ids, http client, transcript reader, resolver
```

## Roadmap

- [x] Architecture & repo scaffold (TS + ESLint + Prettier + Husky)
- [x] Phase 1 — daemon + register/list + status line
- [x] Phase 2 — MCP tools (`whoami`, `list_instances`, `send_message`, `read_inbox`)
- [x] Phase 3 — task-mode wake-up, `read_history` / `search_history` / `get_turn`
- [x] Phase 4 — liveness sweep + lazy daemon autostart
- [x] Phase 5 — folder-name addressing, sharper imperative inbox prompts
- [x] Phase 6 — `claudify run` PTY supervisor for realtime injection
- [ ] Real-world soak across many concurrent supervisor sessions
- [ ] Reply chains: auto-set `from` when a recipient calls `send_message` after waking
- [ ] Optional desktop notification fallback for un-supervised idle sessions

## License

[MIT](./LICENSE) © Tamas Kalman
