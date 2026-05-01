import type * as NodePty from "node-pty";
import { daemon, DaemonError } from "../shared/client.js";
import { ensureDaemonRunning } from "../shared/daemon-spawn.js";

type IPty = NodePty.IPty;

const POLL_REGISTER_INTERVAL_MS = 100;
const EVENTS_LONG_POLL_MS = 25_000;
const STDIN_QUIET_THRESHOLD_MS = 500;
const INJECT_RETRY_MS = 250;
const WAKE_SENTINEL = "[inbox]";

export async function runChild(args: string[]): Promise<void> {
  let ptySpawn: typeof NodePty.spawn;
  try {
    ({ spawn: ptySpawn } = await import("node-pty"));
  } catch (err) {
    console.error(
      "[claudify run] node-pty failed to load. The PTY supervisor needs node-pty (a native module).",
    );
    console.error(`  underlying error: ${(err as Error).message}`);
    console.error("  Try: cd $(npm root -g)/@ktamas77/claudify && npm rebuild node-pty");
    console.error(
      "  Meanwhile you can keep using bare `claude`; hooks + MCP + status line still work,",
    );
    console.error("  just without realtime injection of inbox messages.");
    process.exitCode = 1;
    return;
  }

  const claudeBin = process.env.CLAUDIFY_CLAUDE_BIN ?? "claude";
  const cwd = process.cwd();
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  const env = { ...process.env } as { [key: string]: string };

  await ensureDaemonRunning().catch(() => undefined);

  const child = ptySpawn(claudeBin, args, { name: "xterm-256color", cols, rows, cwd, env });

  const wasRaw = process.stdin.isTTY ? process.stdin.isRaw : false;
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();

  let lastUserKeystrokeAt = 0;
  const onStdin = (data: Buffer | string): void => {
    lastUserKeystrokeAt = Date.now();
    child.write(typeof data === "string" ? data : data.toString("utf8"));
  };
  process.stdin.on("data", onStdin);

  const onChildData = (chunk: string): void => {
    process.stdout.write(chunk);
  };
  child.onData(onChildData);

  const onResize = (): void => {
    const c = process.stdout.columns ?? 80;
    const r = process.stdout.rows ?? 24;
    try {
      child.resize(c, r);
    } catch {
      // child may have exited
    }
  };
  process.stdout.on("resize", onResize);

  const forwardSignal = (sig: NodeJS.Signals): void => {
    try {
      child.kill(sig);
    } catch {
      // child gone
    }
  };
  process.on("SIGINT", forwardSignal);
  process.on("SIGTERM", forwardSignal);

  const exitCode: Promise<number> = new Promise((resolve) => {
    child.onExit(({ exitCode: code, signal }) => {
      resolve(typeof code === "number" ? code : signal ? 128 + signal : 1);
    });
  });

  const subscriberCancel = startSubscriber(child, () => lastUserKeystrokeAt);

  const code = await exitCode;
  subscriberCancel();
  process.stdin.removeListener("data", onStdin);
  process.stdout.removeListener("resize", onResize);
  process.off("SIGINT", forwardSignal);
  process.off("SIGTERM", forwardSignal);
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(wasRaw);
    } catch {
      // best effort
    }
  }
  process.stdin.pause();

  process.exitCode = code;
}

function startSubscriber(child: IPty, lastUserKeystrokeAt: () => number): () => void {
  let cancelled = false;
  let claudeId: string | null = null;
  let pendingWake = false;

  const tryInject = (): void => {
    if (cancelled || !pendingWake) return;
    if (Date.now() - lastUserKeystrokeAt() < STDIN_QUIET_THRESHOLD_MS) {
      setTimeout(tryInject, INJECT_RETRY_MS);
      return;
    }
    if (!claudeId) {
      setTimeout(tryInject, INJECT_RETRY_MS);
      return;
    }
    daemon
      .get(claudeId)
      .then((rec) => {
        if (cancelled || !pendingWake) return;
        if (!rec.idle) {
          setTimeout(tryInject, INJECT_RETRY_MS);
          return;
        }
        try {
          child.write(`${WAKE_SENTINEL}\r`);
          pendingWake = false;
        } catch {
          // child gone
        }
      })
      .catch(() => setTimeout(tryInject, INJECT_RETRY_MS));
  };

  const loop = async (): Promise<void> => {
    while (!cancelled && claudeId === null) {
      try {
        const rec = await daemon.byPid(child.pid, { timeoutMs: 1000 });
        claudeId = rec.claude_id;
      } catch (err) {
        if (err instanceof DaemonError && err.status === 404) {
          await sleep(POLL_REGISTER_INTERVAL_MS);
          continue;
        }
        if (cancelled) return;
        await sleep(POLL_REGISTER_INTERVAL_MS);
      }
    }
    while (!cancelled && claudeId !== null) {
      try {
        const ev = await daemon.events(claudeId, EVENTS_LONG_POLL_MS);
        if (cancelled) return;
        if (ev && ev.type === "message") {
          pendingWake = true;
          tryInject();
        }
      } catch {
        if (cancelled) return;
        await sleep(1000);
      }
    }
  };

  void loop();

  return () => {
    cancelled = true;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
