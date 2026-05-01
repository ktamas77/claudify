import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDirs } from "../shared/paths.js";

interface ClaudeSettings {
  hooks?: Record<string, HookGroup[]>;
  mcpServers?: Record<string, McpServerEntry>;
  statusLine?: StatusLineConfig;
  [k: string]: unknown;
}

interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}

interface HookEntry {
  type: "command";
  command: string;
  timeout?: number;
}

interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface StatusLineConfig {
  type: "command";
  command: string;
}

const HOOK_EVENTS = ["SessionStart", "SessionEnd", "UserPromptSubmit", "Stop"] as const;
const MCP_NAME = "claudify";
const MARK = "claudify-managed";

const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

export function runInstall(): void {
  ensureDirs();
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  const binPath = locateBinary();
  const settings = loadSettings();
  backup(settings);
  applyHooks(settings, binPath);
  applyMcp(settings, binPath);
  applyStatusLine(settings, binPath);
  saveSettings(settings);
  console.log(`installed claudify into ${SETTINGS_PATH}`);
  console.log(`  binary: ${binPath}`);
  console.log(`  backup: ${SETTINGS_PATH}.claudify-backup`);
  console.log(`Restart any open 'claude' sessions to pick up the new hooks + MCP.`);
}

export function runUninstall(): void {
  if (!existsSync(SETTINGS_PATH)) {
    console.log("nothing to uninstall (no settings.json)");
    return;
  }
  const settings = loadSettings();
  removeHooks(settings);
  removeMcp(settings);
  removeStatusLine(settings);
  saveSettings(settings);
  console.log(`uninstalled claudify from ${SETTINGS_PATH}`);
}

function locateBinary(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "bin", "claudify.js");
}

function loadSettings(): ClaudeSettings {
  if (!existsSync(SETTINGS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as ClaudeSettings;
  } catch (err) {
    throw new Error(`failed to parse ${SETTINGS_PATH}: ${(err as Error).message}`);
  }
}

function backup(settings: ClaudeSettings): void {
  if (!existsSync(SETTINGS_PATH)) return;
  const dst = SETTINGS_PATH + ".claudify-backup";
  if (!existsSync(dst)) {
    copyFileSync(SETTINGS_PATH, dst);
  }
  void settings;
}

function saveSettings(settings: ClaudeSettings): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

function applyHooks(settings: ClaudeSettings, binPath: string): void {
  const hooks = (settings.hooks ??= {});
  for (const event of HOOK_EVENTS) {
    const groups: HookGroup[] = (hooks[event] ??= []);
    const ours: HookGroup = {
      hooks: [
        {
          type: "command",
          command: `${nodeInvocation(binPath)} hook ${kebab(event)}`,
        },
      ],
    };
    const existingIdx = groups.findIndex((g: HookGroup) => groupIsOurs(g));
    if (existingIdx >= 0) groups[existingIdx] = ours;
    else groups.push(ours);
  }
}

function removeHooks(settings: ClaudeSettings): void {
  if (!settings.hooks) return;
  for (const event of HOOK_EVENTS) {
    const groups = settings.hooks[event];
    if (!groups) continue;
    settings.hooks[event] = groups.filter((g) => !groupIsOurs(g));
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
}

function groupIsOurs(group: HookGroup): boolean {
  return group.hooks.some((h) => h.command.includes("claudify") && h.command.includes(" hook "));
}

function applyMcp(settings: ClaudeSettings, binPath: string): void {
  settings.mcpServers ??= {};
  settings.mcpServers[MCP_NAME] = {
    command: process.execPath,
    args: [binPath, "mcp"],
  };
}

function removeMcp(settings: ClaudeSettings): void {
  if (!settings.mcpServers) return;
  delete settings.mcpServers[MCP_NAME];
  if (Object.keys(settings.mcpServers).length === 0) delete settings.mcpServers;
}

function applyStatusLine(settings: ClaudeSettings, binPath: string): void {
  const command = `${nodeInvocation(binPath)} statusline`;
  if (settings.statusLine && !isOurStatusLine(settings.statusLine)) {
    console.warn(
      `warning: existing statusLine in settings.json was not installed by claudify; leaving it alone.`,
    );
    console.warn(`         remove it manually if you want claudify's "[id · peers · ✉]" badge.`);
    return;
  }
  settings.statusLine = { type: "command", command };
  void MARK;
}

function isOurStatusLine(sl: StatusLineConfig): boolean {
  return (
    sl.type === "command" && sl.command.includes("claudify") && sl.command.includes("statusline")
  );
}

function removeStatusLine(settings: ClaudeSettings): void {
  if (settings.statusLine && isOurStatusLine(settings.statusLine)) {
    delete settings.statusLine;
  }
}

function nodeInvocation(binPath: string): string {
  return `${shellQuote(process.execPath)} ${shellQuote(binPath)}`;
}

function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9_./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function kebab(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}
