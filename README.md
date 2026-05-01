# claudify

A local side-channel between [Claude Code](https://claude.com/claude-code) CLI sessions running on the same machine. Each session gets a short ID, can list other live sessions, send them messages, and read their conversation history — all over a tiny localhost daemon. No cloud, no network exposure, no auth.

> Status: v0.1 working end-to-end on a single machine — daemon, hooks, MCP tools, status line, CLI. See the roadmap below.

## Why

You probably run `claude` in several folders at once. They have no idea about each other. Claudify gives every session a stable identity and a side channel:

- **List**: which other Claudes are running, where, and for how long.
- **Message**: hand a task to another Claude (`send_message xyz98765 "rerun the migration check"`) — the recipient wakes up with the message injected as its next prompt.
- **Read**: peek at another instance's history (recent turns, search, fetch a specific turn).
- **Notice**: the receiver's status line ticks up (`✉2`) when messages are waiting.

Normal Claude Code usage is unchanged. This is purely additive — installed by patching your global `~/.claude/settings.json` to add hooks, an MCP server, and a status line. Uninstall reverses it.

## How it works

Single local daemon + per-session MCP server + four Claude hooks.

```
┌──────────────────────────── one machine ────────────────────────────┐
│                                                                      │
│   Claude A (folder X)              Claude B (folder Y)               │
│   ├─ SessionStart hook ──┐         ├─ SessionStart hook ──┐          │
│   ├─ UserPromptSubmit ───┤         ├─ UserPromptSubmit ───┤          │
│   ├─ Stop hook ──────────┤         ├─ Stop hook ──────────┤          │
│   ├─ SessionEnd hook ────┤         ├─ SessionEnd hook ────┤          │
│   └─ MCP: claudify  ─────┤         └─ MCP: claudify  ─────┤          │
│                          │                                │          │
│                          ▼                                ▼          │
│                  ┌────────────────────────────────────────────┐      │
│                  │  claudify daemon (HTTP @ 127.0.0.1:7878)   │      │
│                  │   • registry: id ↔ session_id ↔ pid ↔ cwd  │      │
│                  │   • inboxes (one jsonl per claude_id)      │      │
│                  │   • transcript path lookups                │      │
│                  │   • liveness sweep (prune dead PIDs)       │      │
│                  └────────────────────────────────────────────┘      │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

The daemon binds to `127.0.0.1` only. State is persisted to `~/.claudify/`.

### How a Claude Code session learns its own ID

Claude Code spawns hooks and MCP servers as direct subprocesses, so they share the same parent PID (the `claude` process itself). The `SessionStart` hook registers the session with the daemon (it knows `session_id`, `claude_pid = ppid`, `cwd`, `transcript_path`); the MCP server, on first tool call, looks itself up by parent PID. No env-var plumbing required.

### Status line

```
[abc12345 · 3 peers · ✉2]
```

- `abc12345` — this session's ID
- `3 peers` — count of _other_ live Claudes (drops out at zero)
- `✉2` — unread inbox messages from sister Claudes (drops out at zero)

## Install

> Requires Node ≥ 20.

```bash
npm i -g @ktamas77/claudify
claudify install
```

`claudify install` patches your global `~/.claude/settings.json` (with a backup) to register the four hooks, the `claudify` MCP server, and the status-line script. Then start (or restart) any `claude` session and you'll see your ID in the status line.

```bash
claudify uninstall   # reverses the install
```

## CLI

```
claudify list                   # show all live Claude sessions
claudify whoami                 # this shell's parent claude (best-effort by ppid)
claudify send <id> <message>    # send a message to a session from any shell
claudify history <id> [-n N]    # tail another session's transcript
claudify search <id> <query>    # search another session's transcript
claudify status                 # daemon health + instance count
claudify daemon                 # foreground daemon (used by lazy spawn)
claudify mcp                    # stdio MCP server (spawned by claude)
claudify hook <event>           # internal: hook handler
```

## MCP tools

The `claudify` MCP server exposes:

| Tool                                       | Purpose                                                                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `whoami`                                   | Your own `claude_id`, cwd, started_at.                                                                                                         |
| `list_instances`                           | All live sessions: id, cwd, last_active, pending count.                                                                                        |
| `send_message(to, body, kind?)`            | Send to another session. `kind: "task"` (default) wakes an idle recipient via its `Stop` hook; `kind: "note"` is silent until the next prompt. |
| `read_inbox(drain?)`                       | Pull pending messages for the current session (defaults to draining).                                                                          |
| `read_history(id, last_n_turns?, redact?)` | Recent turns from another session, redacted by default; pass `redact: false` for raw.                                                          |
| `search_history(id, query, options?)`      | Substring/regex search over another session's transcript with surrounding context.                                                             |
| `get_turn(id, turn_index)`                 | Pinpoint full-content fetch of one turn after `read_history` / `search_history` flagged it.                                                    |

## Message delivery

Two kinds:

- **task** (default) — recipient's `Stop` hook blocks the stop and feeds messages in as the next prompt; also surfaces on next `UserPromptSubmit`. Effectively wakes an idle Claude.
- **note** — surfaces only on next `UserPromptSubmit`; doesn't wake the model.

Inbox is at-least-once and drained on read.

## Privacy & security

- Daemon binds to `127.0.0.1` only — never `0.0.0.0`. Single-user assumption matches the rest of `~/.claude`.
- `read_history` redacts large tool results / file contents above a per-line byte cap by default. Pass `redact: false` (or use `get_turn`) for raw.
- Hooks fail open: any daemon error is logged and the hook exits 0. Claude Code keeps working with no claudify integration if the daemon is down.

## Development

```bash
git clone git@github.com:ktamas77/claudify.git
cd claudify
npm install
npm run build       # tsc → dist/
npm run dev         # tsc --watch
npm run lint        # eslint
npm run format      # prettier --write
npm run typecheck   # tsc --noEmit
```

Pre-commit runs `lint-staged` (eslint --fix + prettier --write) on staged files via husky.

### Layout

```
src/
├── bin/claudify.ts          # entrypoint, dispatches all subcommands
├── daemon/                  # HTTP server, registry, inbox, liveness
├── mcp/server.ts            # stdio MCP server
├── hooks/                   # session-start, session-end, user-prompt-submit, stop
├── cli/                     # list, send, history, search, install, …
└── shared/                  # paths, ids, http client, transcript reader
```

## Roadmap

- [x] Architecture & repo scaffold (TS + ESLint + Prettier + Husky)
- [x] Phase 1 — daemon + register/list + status line
- [x] Phase 2 — MCP tools (`whoami`, `list_instances`, `send_message`, `read_inbox`)
- [x] Phase 3 — task-mode wake-up, `read_history` / `search_history` / `get_turn`
- [x] Phase 4 — liveness sweep + lazy daemon autostart
- [ ] Real-world testing across many concurrent sessions; iterate
- [ ] Proper test suite (smoke covers the happy path, but no unit tests yet)
- [ ] Publish `@ktamas77/claudify` to npm

## License

[MIT](./LICENSE) © Tamas Kalman
