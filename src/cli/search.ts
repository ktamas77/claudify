import { daemon } from "../shared/client.js";
import { ensureDaemonRunning } from "../shared/daemon-spawn.js";

export async function runSearch(args: string[]): Promise<void> {
  const id = args[0];
  const query = args
    .slice(1)
    .filter((a) => !a.startsWith("--"))
    .join(" ");
  let context: number | undefined;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--context" || arg === "-C") {
      context = Number(args[++i]);
    }
  }
  if (!id || !query) {
    console.error("usage: claudify search <id> <query> [--context N]");
    process.exitCode = 2;
    return;
  }
  await ensureDaemonRunning();
  const params: { context?: number } = {};
  if (context !== undefined) params.context = context;
  const result = await daemon.search(id, query, params);
  console.log(JSON.stringify(result, null, 2));
}
