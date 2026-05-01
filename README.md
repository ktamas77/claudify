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

`claudify install` patches two files (each backed up first):

- `~/.claude/settings.json` — adds the four hooks and the status-line script
- `~/.claude.json` — adds the `claudify` MCP server under `mcpServers`

Then start (or restart) any `claude` session and you'll see your ID in the status line.

```bash
claudify uninstall   # reverses the install
```

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

`claudify statusline` reads the same JSON Claude Code already pipes to your script (it needs `session_id`), prints `[id · peers · ✉N]`, and exits silently with no output if the daemon is down or the session isn't registered yet — so it's safe to leave in even when claudify isn't running.

## CLI

```
claudify list                          # show all live Claude sessions
claudify whoami                        # this shell's parent claude (best-effort by ppid)
claudify send <target> <message>       # send a message; target is a claude_id or folder name
claudify history <target> [-n N]       # tail another session's transcript
claudify search <target> <query>       # search another session's transcript
claudify status                        # daemon health + instance count
claudify daemon                        # foreground daemon (used by lazy spawn)
claudify mcp                           # stdio MCP server (spawned by claude)
claudify hook <event>                  # internal: hook handler
```

### Addressing sessions: id or folder name

Anywhere a target is expected — CLI commands and MCP tools alike — you can pass either the 8-char `claude_id` or the **basename of that session's working directory**. The resolver:

1. Tries an exact `claude_id` match against the live registry.
2. Falls back to a case-insensitive match on `basename(cwd)`.

```bash
# These two are equivalent when one live session is running in /Users/me/dev/api-service
claudify send 7k3p9q2x "rerun the migration check"
claudify send api-service "rerun the migration check"
```

If the folder name matches more than one live session (e.g. you have `~/orgA/api` and `~/orgB/api` both running), the resolver errors out and shows you both `claude_id`s plus their full paths so you can disambiguate by id. If nothing matches, it prints all live sessions to make picking one easy.

## MCP tools

The `claudify` MCP server exposes the following. Wherever a tool takes a target session, you can pass either an 8-char `claude_id` or a folder basename (see [Addressing sessions](#addressing-sessions-id-or-folder-name)).

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

- **task** (default) — recipient's `Stop` hook blocks the stop and injects the message body as a directive the model must act on (not just acknowledge); also surfaces on next `UserPromptSubmit`. Best at waking a Claude that is _just finishing a turn_.
- **note** — surfaces only on next `UserPromptSubmit`; doesn't block stops, doesn't wake the model.

Inbox is at-least-once and drained on read.

### Timing caveat

A `task` message wakes the recipient only if it arrives while the recipient is between turns (the `Stop` hook is firing). If the recipient is **already fully idle** when the message lands, no event fires — the message sits in the inbox until the user submits a new prompt to that recipient, at which point it's delivered to that turn as additional context. The `✉N` count in the status line is the cue.

There's no clean way to inject input into an already-idle interactive Claude session from outside the process (TTY-injection ioctls like `TIOCSTI` are restricted on modern macOS/Linux). If you need guaranteed delivery to a stalled recipient, type any prompt in that session — the inbox drains on the next turn.

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
