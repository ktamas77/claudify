import { readFileSync, existsSync, statSync } from "node:fs";
import { loadConfig } from "./config.js";

export interface TranscriptTurn {
  index: number;
  role?: string;
  type?: string;
  ts?: string;
  preview: string;
  raw?: unknown;
  truncated: boolean;
}

interface RawJsonlLine {
  type?: string;
  role?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
  [k: string]: unknown;
}

export interface ReadOptions {
  lastNTurns?: number;
  redact?: boolean;
}

export interface SearchOptions {
  context?: number;
  redact?: boolean;
}

export function readTranscript(path: string, opts: ReadOptions = {}): TranscriptTurn[] {
  const lines = loadJsonlLines(path);
  const turns = lines.map((raw, i) => toTurn(raw, i, opts.redact ?? true));
  if (opts.lastNTurns !== undefined && opts.lastNTurns > 0) {
    return turns.slice(-opts.lastNTurns);
  }
  return turns;
}

export function searchTranscript(
  path: string,
  query: string,
  opts: SearchOptions = {},
): TranscriptTurn[] {
  const lines = loadJsonlLines(path);
  const ctx = opts.context ?? 1;
  const matchedIndices = new Set<number>();
  const lower = query.toLowerCase();
  let regex: RegExp | null = null;
  try {
    if (query.startsWith("/") && query.lastIndexOf("/") > 0) {
      const lastSlash = query.lastIndexOf("/");
      const pattern = query.slice(1, lastSlash);
      const flags = query.slice(lastSlash + 1);
      regex = new RegExp(pattern, flags);
    }
  } catch {
    regex = null;
  }
  lines.forEach((raw, i) => {
    const text = stringifyForSearch(raw).toLowerCase();
    const hit = regex ? regex.test(text) : text.includes(lower);
    if (hit) {
      for (let j = Math.max(0, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j++) {
        matchedIndices.add(j);
      }
    }
  });
  const sorted = [...matchedIndices].sort((a, b) => a - b);
  return sorted.map((i) => toTurn(lines[i]!, i, opts.redact ?? true));
}

export function getTurn(path: string, index: number): TranscriptTurn | null {
  const lines = loadJsonlLines(path);
  if (index < 0 || index >= lines.length) return null;
  return toTurn(lines[index]!, index, false);
}

function loadJsonlLines(path: string): RawJsonlLine[] {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (stat.size === 0) return [];
  const raw = readFileSync(path, "utf8");
  const out: RawJsonlLine[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as RawJsonlLine);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

function toTurn(raw: RawJsonlLine, index: number, redact: boolean): TranscriptTurn {
  const cap = loadConfig().redact.line_byte_cap;
  const role = raw.role ?? raw.message?.role;
  const type = raw.type;
  const ts = raw.timestamp;
  const preview = previewOf(raw);
  const truncated = preview.length > cap;
  const finalPreview = redact && truncated ? preview.slice(0, cap) + "…[truncated]" : preview;
  const turn: TranscriptTurn = {
    index,
    preview: finalPreview,
    truncated: redact && truncated,
  };
  if (role !== undefined) turn.role = role;
  if (type !== undefined) turn.type = type;
  if (ts !== undefined) turn.ts = ts;
  if (!redact) turn.raw = raw;
  return turn;
}

function previewOf(raw: RawJsonlLine): string {
  const content = raw.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as { type?: string; text?: string; content?: unknown };
          if (typeof p.text === "string") return p.text;
          if (p.type) return `[${p.type}]`;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(raw);
}

function stringifyForSearch(raw: RawJsonlLine): string {
  const preview = previewOf(raw);
  return `${preview}\n${JSON.stringify(raw)}`;
}
