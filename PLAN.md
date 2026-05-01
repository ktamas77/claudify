# Claudify — Plan

A side-channel that lets multiple `claude` CLI sessions on the same machine
discover, message, and read each other.

---

## 1. User experience (what we're building)

You launch Claude Code as usual in any number of folders. In each terminal:

- The status line shows a short, unique ID (e.g. `[abc12345]`).
- A new MCP server `claudify` is available with tools like
  `list_instances`, `send_message`, `read_history`, `read_inbox`, `whoami`.
- You can paste another instance's ID into your current Claude and say
  *"send this task to `xyz98765`"* — the other Claude wakes up with the
  message injected as the next prompt.
- You can read another instance's transcript on demand.
- Everything stays local: one tiny daemon at `127.0.0.1:7878`, no
  cloud, no auth, no remote exposure.

Nothing changes about how you normally use `claude`. This is purely
additive.

---

## 2. Recommended architecture

Single local daemon + per-instance MCP server + Claude hooks.

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
│   $HOME/.claudify/                                                   │
│     registry.json    ← canonical state, atomically rewritten         │
│     sessions/<session_id>.json   ← per-session pointer              │
│     inbox/<claude_id>.jsonl                                          │
│     daemon.{pid,sock,log}                                            │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### Why a daemon (vs. pure-MCP-only)

A daemon owns three things that no per-instance process can: a stable
listening port, a single source of truth for the registry, and an
inbox that survives if the recipient is mid-tool-call. Without it
you'd need filesystem locking + every-tool-call rescan, which is
fragile.

The daemon is auto-started on first `SessionStart` (lazy), so the
user never runs anything by hand.

---

## 3. Components

### 3.1 `claudify-daemon`

- One process per machine, bound to `127.0.0.1:7878` (configurable).
- Single small Node.js (or Bun) binary, no native deps.
- Persists state to `~/.claudify/registry.json` (atomic rename).
- Endpoints:
  - `POST /register` `{ session_id, claude_pid, cwd, transcript_path }`
    → returns `{ claude_id }` (8 hex chars).
  - `DELETE /instances/:id` (called from SessionEnd).
  - `GET /instances` → list all live instances.
  - `GET /instances/:id` → details (cwd, started_at, last_active).
  - `GET /by-pid/:ppid` → lookup by parent pid (used by MCP to learn its
    own ID without needing session_id).
  - `POST /instances/:id/messages` `{ from, body, kind? }` → append to
    inbox, set `has_pending=true`.
  - `GET /instances/:id/messages?drain=1` → return + clear inbox.
  - `GET /instances/:id/history?limit=N&since=...` → reads the
    instance's `transcript_path` jsonl and returns recent turns
    (filtered server-side so a 50k-line transcript doesn't go through
    MCP).
  - `GET /healthz`.
- Liveness sweep every 10s: `kill -0 pid` per registered instance,
  evict dead ones.

### 3.2 `claudify` MCP server (stdio, per Claude)

Configured in `~/.claude/settings.json` under `mcpServers`. Claude
Code spawns one per session. On boot:

1. Looks up its own parent PID (= Claude Code's PID).
2. Calls `GET /by-pid/<ppid>` on the daemon, retrying with backoff
   until the SessionStart hook has registered (typically <1s).
3. Caches its `claude_id` for the rest of the session.

Tools exposed:

| Tool | Purpose |
|---|---|
| `whoami` | Returns this instance's `claude_id`, cwd, started_at. |
| `list_instances` | Returns all live instances with id, cwd, last_active, pending message count. |
| `send_message(to, body, kind?)` | Sends a message to another instance's inbox. `kind` can be `"task"` (default — wakes recipient) or `"note"` (silent). |
| `read_inbox(drain?)` | Returns this instance's pending messages; default drains. |
| `read_history(id, last_n_turns?, redact?)` | Returns recent turns from another instance's transcript. Redacted by default (file contents truncated above a byte cap, large tool results summarized); `redact: false` returns full content (explicit opt-in). |
| `search_history(id, query, options?)` | Substring or regex search within another instance's transcript. Returns matching turns with N turns of surrounding context. Useful for "did they ever run X" / "what did they decide about Y" without paging through everything. |
| `get_turn(id, turn_index)` | Fetch one specific turn by its index, full content, no redaction. Opt-in pinpoint reads after `read_history`/`search_history` show what's interesting. |

### 3.3 Hooks (the Claude side of the integration)

All four hooks invoke the same binary with a subcommand:
`claudify hook <event>` and read JSON on stdin.

- **`SessionStart`** — registers with daemon (sends `session_id`,
  `process.ppid`, `cwd`, `transcript_path`), receives `claude_id`,
  writes `~/.claudify/sessions/<session_id>.json` so the status line
  can find it.
- **`UserPromptSubmit`** — drains inbox; if non-empty, returns
  `additionalContext` containing pending messages framed as
  `<inbox-message from=abc12345 at=...>...</inbox-message>` blocks.
  This is how a remote Claude actually sees what was sent.
- **`Stop`** — if inbox is non-empty AND `kind=task`, returns
  `{ "decision": "block", "reason": "<inbox messages>" }` so Claude
  doesn't go idle while a sister instance is waiting on it. Skipped
  for `kind=note`.
- **`SessionEnd`** — unregisters and removes the per-session file.

### 3.4 Status line script

One-liner registered as `statusLine` in user settings. Reads stdin
(Claude Code passes `{session_id, ...}`), looks up
`~/.claudify/sessions/<session_id>.json`, prints the badge. Falls
back to empty string if the daemon hasn't registered yet, so it
never breaks Claude.

**Default badge format**: `[abc12345 · 3 peers · ✉2]`

- `abc12345` — this instance's id.
- `3 peers` — count of *other* live instances (not counting self).
  Drops out at zero so a lone Claude shows just `[abc12345]`.
- `✉2` — pending **remote messages**: unread inbox entries from
  sister Claudes, waiting to be drained on the next
  `UserPromptSubmit`. Drops out at zero. This is the passive
  notification: when someone sends you a task and you're idle, you
  see `✉1` appear in your status line.

Configurable via `~/.claudify/config.json`:

```json
{ "statusline": { "show_peers": true, "show_inbox": true } }
```

The daemon already tracks `pending_count` per instance (it owns the
inbox); the status-line script just reads `registry.json`.

### 3.5 `claudify` CLI

Same binary, different subcommands:

```
claudify install         # write hooks + MCP entry into ~/.claude/settings.json
claudify uninstall
claudify daemon          # foreground daemon (used by launchd / autostart)
claudify mcp             # stdio MCP server (spawned by claude)
claudify hook <event>    # internal: hook handler
claudify list            # human-readable instance table
claudify send <id> <msg> # send from a non-Claude shell
claudify history <id>    # tail another instance's transcript
claudify whoami          # ID of the current shell's parent claude (best-effort by ppid)
claudify status          # daemon health + instance count
```

---

## 4. Data model

### Registry entry (in-memory + persisted)

```json
{
  "claude_id":       "abc12345",
  "session_id":      "uuid-from-claude-code",
  "claude_pid":      54321,
  "cwd":             "/Users/.../voidbot",
  "transcript_path": "/Users/.../.claude/projects/.../uuid.jsonl",
  "started_at":      "2026-05-01T12:34:56Z",
  "last_active":     "2026-05-01T12:35:10Z",
  "pending_count":   0
}
```

### Inbox entry (one line per message)

```json
{
  "id":   "msg_01HX...",
  "from": "abc12345",
  "to":   "xyz98765",
  "kind": "task",
  "body": "please re-run the build and report back",
  "ts":   "2026-05-01T12:35:08Z"
}
```

### Storage layout

```
~/.claudify/
├── registry.json          # full snapshot, atomically rewritten
├── sessions/
│   └── <session_id>.json  # { claude_id, transcript_path } — for status line
├── inbox/
│   └── <claude_id>.jsonl  # append-only, drained on read
├── daemon.pid
├── daemon.log
└── config.json            # port, log level, history caps
```

---

## 5. Lifecycle & identification

The hard problem: an MCP stdio server doesn't directly receive
`session_id`. We solve it by joining on the Claude Code PID.

```
Claude Code starts (pid=P)
  ├─ spawns MCP claudify         (process.ppid === P)
  └─ fires SessionStart hook     (process.ppid === P)
                                 │
                                 ▼
                  hook → daemon.register({ session_id, claude_pid: P, … })
                                 │
                                 ▼
                  daemon assigns claude_id, indexes by P

MCP first tool call:
  → daemon.lookupByPid(process.ppid === P)
  → returns claude_id  ✓
```

If two Claudes ever shared a PID (they can't — different processes),
this breaks; otherwise the join is exact.

Race: if MCP calls `lookupByPid` before SessionStart finishes, it
gets 404 and retries with 100ms backoff up to ~5s. In practice
SessionStart finishes in tens of ms.

---

## 6. Message delivery semantics

Two delivery modes, chosen per send:

- **task** (default) — recipient's `Stop` hook blocks the stop and
  injects messages as next prompt; messages also surface on next
  `UserPromptSubmit`. Effectively: "the sister Claude will work on
  this next."
- **note** — appears on the recipient's next `UserPromptSubmit` only;
  doesn't wake the model. Use for FYI / sharing context.

Messages are at-least-once but the inbox is drained on read, so the
sender shouldn't expect re-delivery. We surface a delivery ack via
the daemon's `last_drained_at`.

If the recipient ID doesn't exist, `send_message` returns an error
that includes the current live list so the sender can recover.

---

## 7. Security & safety

- Daemon binds to `127.0.0.1` only — never `0.0.0.0`.
- No auth (single-user assumption, like the rest of `~/.claude`).
  Future: per-instance bearer token written to the same dir, scoped
  by Unix file mode.
- Inbox messages are plain text; the sending instance is identified
  by its `claude_id`. No spoofing protection within the host (any
  process that can talk to the daemon can claim to be any id) — fine
  for single-user, dangerous if exposed off-host. Hence localhost
  binding is non-negotiable.
- `read_history` truncates by line count and per-line byte cap; never
  ships full file contents through MCP.
- Hooks fail open: any daemon error is logged and the hook exits 0.
  Claude Code keeps working with no claudify integration.

---

## 8. Why not… (alternatives considered)

- **Pure MCP, no daemon.** Each instance would need to listen on its
  own port and discover others by scanning. The registry becomes
  filesystem locks + races. Ruled out.
- **Wrapper around `claude`.** Forces the user to launch Claude
  differently. The hook + MCP approach is invisible after install.
- **OrbStack-routed HTTP.** Pretty URLs (`claudify.local`) but adds
  Docker dependency for something trivially served by a Node
  process. Save for v2 if useful.
- **Filesystem-only IPC** (drop messages into a folder). Works but
  no liveness, no pid-join, status line becomes flaky.

---

## 9. Implementation roadmap

### Phase 1 — minimum viable side channel (~1 day)

- [ ] Node.js daemon with the endpoints in §3.1, in-memory state,
      persisted on every write.
- [ ] `claudify hook session-start` + `session-end`.
- [ ] Status line script.
- [ ] `claudify install` — patches `~/.claude/settings.json` (with a
      backup) to register MCP + hooks + status line.
- [ ] `claudify list` CLI.

Test: launch two Claudes, see both IDs in status lines and
`claudify list`.

### Phase 2 — MCP tools (~½ day)

- [ ] `claudify mcp` stdio server.
- [ ] Tools: `whoami`, `list_instances`, `send_message`, `read_inbox`.
- [ ] `UserPromptSubmit` hook drains inbox.
- [ ] Status-line peers + ✉ counts (driven by daemon's per-instance
      `pending_count`).

Test: from Claude A, `send_message` to B; B's next prompt sees the
message.

### Phase 3 — task mode + history (~½ day)

- [ ] `Stop` hook with `decision: block` for `kind=task`.
- [ ] `read_history` / `search_history` / `get_turn` tools (see §3.2).
- [ ] `claudify send` / `claudify history` / `claudify search` CLI
      for non-Claude use.

Test: A sends a task to idle B; B wakes and starts working on it.

### Phase 4 — polish

- [ ] Liveness sweep + stale entry pruning.
- [ ] Auto-start daemon via `launchd` plist (optional — lazy spawn
      from hooks already covers it).
- [ ] `claudify status` and config file.
- [ ] README + screenshots.

---

## 10. File layout (proposed)

```
claudify/
├── PLAN.md                ← this file
├── README.md
├── package.json
├── src/
│   ├── daemon/
│   │   ├── server.ts      # HTTP routes
│   │   ├── registry.ts    # in-memory + persistence
│   │   ├── inbox.ts
│   │   └── liveness.ts
│   ├── mcp/
│   │   └── server.ts      # stdio MCP, the 5 tools
│   ├── hooks/
│   │   ├── session-start.ts
│   │   ├── session-end.ts
│   │   ├── user-prompt-submit.ts
│   │   └── stop.ts
│   ├── cli/
│   │   ├── install.ts
│   │   ├── list.ts
│   │   ├── send.ts
│   │   └── history.ts
│   ├── shared/
│   │   ├── ids.ts         # 8-char id generator
│   │   ├── paths.ts       # ~/.claudify resolution
│   │   └── client.ts      # daemon HTTP client (also retry/backoff)
│   └── bin/claudify.ts    # subcommand dispatcher
└── statusline.sh          # tiny shim: read stdin, look up id, echo
```

Single binary entry point (`claudify`). Daemon, MCP, hooks, CLI all
reach the same code through subcommand dispatch — keeps install
simple (one command in PATH, one MCP server entry).

---

## 11. Resolved decisions

1. **Distribution → public npm package on npmjs.com.**

   Published as `claudify` (or `@ktamas77/claudify` if the unscoped
   name is taken). User installs with `npm i -g claudify`, gets a
   `claudify` binary on PATH that dispatches every subcommand
   (`daemon`, `mcp`, `hook <event>`, `install`, `list`, `send`, …).

   - One Node.js codebase (TypeScript → JS via `tsc`); no per-arch
     build matrix, no Homebrew tap, no Apple Developer ID,
     no Gatekeeper / `xattr` quarantine quirks.
   - settings.json hook commands invoke the globally-installed
     binary directly (`claudify hook session-start`), **not** `npx`.
     This skips the `npx` resolution penalty — cold start lands
     around ~80–120ms on a warm Node, which is acceptable for hooks
     that fire per-prompt / per-turn but not per-keystroke.
   - Updates: `npm i -g claudify@latest`, optionally wrapped by a
     `claudify upgrade` subcommand.
   - Engines pinned in `package.json` (`node >= 20`) to avoid
     surprises on stale installs.

   Bun-compiled single binary + Homebrew tap stays on the table as a
   v2 optimisation if hook latency ever becomes a real papercut. The
   architecture (daemon + MCP + hooks + CLI under one entrypoint) is
   unchanged either way — only the packaging differs.

2. **Daemon autostart → lazy.** First hook to find no daemon spawns
   one. Zero config, zero plist files, no review by macOS Login
   Items. If it ever proves unreliable (hook racing on simultaneous
   first-launches), add a `launchd` plist as opt-in via
   `claudify install --launchd`.

3. **Cross-machine → out of scope, kept open.** Not part of v1. If
   it becomes interesting, build it as its own dedicated
   service — *not* a feature bolted onto `forever-plugin`. Local
   daemon stays single-host; a future `claudify-relay` cloud service
   could bridge across machines while keeping the local daemon
   unchanged. (Design note: the registry/inbox API is intentionally
   small enough to relay verbatim.)

4. **History reads → split into three tools, redacted by default,
   full content opt-in.**

   - `read_history(id, last_n_turns?, redact?)` — recent turns;
     redacts large tool results and file contents above a byte cap
     by default; `redact: false` to get raw.
   - `search_history(id, query, options?)` — substring/regex search
     across an instance's transcript; returns matching turns with
     surrounding context. Lets a sister Claude ask "did they ever
     run the migration?" without scanning the whole log.
   - `get_turn(id, turn_index)` — pinpoint full-content fetch of one
     turn by index, no redaction. Use after `read_history` /
     `search_history` reveal an interesting turn.

   Redaction defaults are config knobs in `~/.claudify/config.json`
   (per-line byte cap, tool-result summarization on/off).

5. **Status line → show pending remote-message count.** Default
   format `[abc12345 · 3 peers · ✉2]`. The `✉` count is the inbox
   depth — messages from sister Claudes waiting to be drained on
   next `UserPromptSubmit`. Drops out at zero so an idle, lonely
   Claude just shows `[abc12345]`. See §3.4 for full spec.
