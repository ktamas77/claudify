import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { paths, ensureDirs } from "./paths.js";
import { DEFAULT_CONFIG, type DaemonConfig } from "./types.js";

export function loadConfig(): DaemonConfig {
  if (!existsSync(paths.config)) {
    return DEFAULT_CONFIG;
  }
  try {
    const raw = readFileSync(paths.config, "utf8");
    const parsed = JSON.parse(raw) as Partial<DaemonConfig>;
    return mergeConfig(DEFAULT_CONFIG, parsed);
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function writeDefaultConfigIfMissing(): void {
  ensureDirs();
  if (existsSync(paths.config)) return;
  writeFileSync(paths.config, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
}

function mergeConfig(base: DaemonConfig, overlay: Partial<DaemonConfig>): DaemonConfig {
  return {
    port: overlay.port ?? base.port,
    host: overlay.host ?? base.host,
    redact: { ...base.redact, ...(overlay.redact ?? {}) },
    statusline: { ...base.statusline, ...(overlay.statusline ?? {}) },
  };
}
