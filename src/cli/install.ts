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
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface StatusLineConfig {
  type: "command";
  command: string;
}

interface ClaudeJson {
  mcpServers?: Record<string, McpServerEntry>;
  [k: string]: unknown;
}

const HOOK_EVENTS = ["SessionStart", "SessionEnd", "UserPromptSubmit", "Stop"] as const;
const MCP_NAME = "claudemesh";
const MARK = "claudemesh-managed";

const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const CLAUDE_JSON_PATH = join(homedir(), ".claude.json");

export function runInstall(): void {
  ensureDirs();
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  const binPath = locateBinary();
  const settings = loadSettings();
  backup(SETTINGS_PATH);
  applyHooks(settings, binPath);
  cleanStaleSettingsMcp(settings);
  applyStatusLine(settings, binPath);
  saveSettings(settings);

  const claudeJson = loadClaudeJson();
  backup(CLAUDE_JSON_PATH);
  applyMcp(claudeJson, binPath);
  saveClaudeJson(claudeJson);

  console.log(`installed claudemesh`);
  console.log(`  hooks + statusLine: ${SETTINGS_PATH}`);
  console.log(`  mcp server:         ${CLAUDE_JSON_PATH}`);
  console.log(`  binary:             ${binPath}`);
  console.log(`Restart any open 'claude' sessions to pick up the new hooks + MCP.`);
}

export function runUninstall(): void {
  if (existsSync(SETTINGS_PATH)) {
    const settings = loadSettings();
    removeHooks(settings);
    cleanStaleSettingsMcp(settings);
    removeStatusLine(settings);
    saveSettings(settings);
    console.log(`uninstalled claudemesh hooks + statusLine from ${SETTINGS_PATH}`);
  }
  if (existsSync(CLAUDE_JSON_PATH)) {
    const claudeJson = loadClaudeJson();
    removeMcp(claudeJson);
    saveClaudeJson(claudeJson);
    console.log(`uninstalled claudemesh mcp server from ${CLAUDE_JSON_PATH}`);
  }
}

function locateBinary(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "bin", "claudemesh.js");
}

function loadSettings(): ClaudeSettings {
  if (!existsSync(SETTINGS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as ClaudeSettings;
  } catch (err) {
    throw new Error(`failed to parse ${SETTINGS_PATH}: ${(err as Error).message}`);
  }
}

function loadClaudeJson(): ClaudeJson {
  if (!existsSync(CLAUDE_JSON_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CLAUDE_JSON_PATH, "utf8")) as ClaudeJson;
  } catch (err) {
    throw new Error(`failed to parse ${CLAUDE_JSON_PATH}: ${(err as Error).message}`);
  }
}

function backup(path: string): void {
  if (!existsSync(path)) return;
  const dst = path + ".claudemesh-backup";
  if (!existsSync(dst)) {
    copyFileSync(path, dst);
  }
}

function saveSettings(settings: ClaudeSettings): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

function saveClaudeJson(claudeJson: ClaudeJson): void {
  writeFileSync(CLAUDE_JSON_PATH, JSON.stringify(claudeJson, null, 2) + "\n", "utf8");
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
  return group.hooks.some((h) => h.command.includes("claudemesh") && h.command.includes(" hook "));
}

function applyMcp(claudeJson: ClaudeJson, binPath: string): void {
  claudeJson.mcpServers ??= {};
  claudeJson.mcpServers[MCP_NAME] = {
    type: "stdio",
    command: process.execPath,
    args: [binPath, "mcp"],
    env: {},
  };
}

function removeMcp(claudeJson: ClaudeJson): void {
  if (!claudeJson.mcpServers) return;
  delete claudeJson.mcpServers[MCP_NAME];
  if (Object.keys(claudeJson.mcpServers).length === 0) delete claudeJson.mcpServers;
}

function cleanStaleSettingsMcp(settings: ClaudeSettings): void {
  if (!settings.mcpServers) return;
  delete settings.mcpServers[MCP_NAME];
  if (Object.keys(settings.mcpServers).length === 0) delete settings.mcpServers;
}

function applyStatusLine(settings: ClaudeSettings, binPath: string): void {
  const command = `${nodeInvocation(binPath)} statusline`;
  if (settings.statusLine && !isOurStatusLine(settings.statusLine)) {
    console.warn(
      `warning: existing statusLine in settings.json was not installed by claudemesh; leaving it alone.`,
    );
    console.warn(`         remove it manually if you want claudemesh's "[id · peers · ✉]" badge.`);
    return;
  }
  settings.statusLine = { type: "command", command };
  void MARK;
}

function isOurStatusLine(sl: StatusLineConfig): boolean {
  return (
    sl.type === "command" && sl.command.includes("claudemesh") && sl.command.includes("statusline")
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
