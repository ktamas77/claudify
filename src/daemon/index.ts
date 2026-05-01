import { startDaemon } from "./server.js";
import { writeDefaultConfigIfMissing } from "../shared/config.js";
import { paths } from "../shared/paths.js";
import { writeFileSync } from "node:fs";

export async function runDaemon(): Promise<void> {
  writeDefaultConfigIfMissing();
  writeFileSync(paths.daemonPid, String(process.pid));
  await startDaemon();
}
