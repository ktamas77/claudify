#!/usr/bin/env node
import { runDaemon } from "../daemon/index.js";
import { runMcpServer } from "../mcp/server.js";
import { runSessionStartHook } from "../hooks/session-start.js";
import { runSessionEndHook } from "../hooks/session-end.js";
import { runUserPromptSubmitHook } from "../hooks/user-prompt-submit.js";
import { runStopHook } from "../hooks/stop.js";
import { runInstall, runUninstall } from "../cli/install.js";
import { runList } from "../cli/list.js";
import { runWhoami } from "../cli/whoami.js";
import { runSend } from "../cli/send.js";
import { runHistory } from "../cli/history.js";
import { runSearch } from "../cli/search.js";
import { runStatus } from "../cli/status.js";
import { runStatusLine } from "../cli/statusline.js";
import { runChild } from "../cli/run.js";

const HELP = `claudify — local side-channel between Claude Code sessions

Usage:
  claudify <command> [args]

Run claude with realtime inbox delivery (recommended):
  run [claude args...]    launch \`claude\` inside a PTY supervisor that injects
                          inbox messages the moment they arrive, even when claude
                          is fully idle. Set CLAUDIFY_CLAUDE_BIN to override the
                          claude binary used (default: \`claude\` on PATH).

Setup:
  install                 patch hooks + MCP + statusline into your Claude config
  uninstall               remove the patch

Inspect:
  list                    list live Claude sessions
  whoami                  show this shell's parent claude session
  status                  daemon health + instance count

Send / read (target = claude_id or folder basename):
  send <target> <msg...>  send a task message (--note for silent delivery)
  history <target> [-n N] read recent turns (default 20; --raw for unredacted)
  search <target> <query> search a session's transcript

Internal (used by Claude Code):
  daemon                  run the foreground daemon
  mcp                     run the stdio MCP server
  hook <event>            run a hook handler (session-start, session-end, …)
  statusline              produce status-line text from stdin JSON
`;

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    case "run":
      await runChild(rest);
      return;
    case "daemon":
      await runDaemon();
      return;
    case "mcp":
      await runMcpServer();
      return;
    case "install":
      runInstall();
      return;
    case "uninstall":
      runUninstall();
      return;
    case "list":
      await runList();
      return;
    case "whoami":
      await runWhoami();
      return;
    case "send":
      await runSend(rest);
      return;
    case "history":
      await runHistory(rest);
      return;
    case "search":
      await runSearch(rest);
      return;
    case "status":
      await runStatus();
      return;
    case "statusline":
      await runStatusLine();
      return;
    case "hook":
      await runHook(rest[0]);
      return;
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.error(HELP);
      process.exitCode = 2;
  }
}

async function runHook(event: string | undefined): Promise<void> {
  switch (event) {
    case "session-start":
      await runSessionStartHook();
      return;
    case "session-end":
      await runSessionEndHook();
      return;
    case "user-prompt-submit":
      await runUserPromptSubmitHook();
      return;
    case "stop":
      await runStopHook();
      return;
    default:
      console.error(`unknown hook event: ${event ?? "<missing>"}`);
      process.exitCode = 2;
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`[claudify] ${msg}`);
  process.exit(1);
});
