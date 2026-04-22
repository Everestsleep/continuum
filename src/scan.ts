import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSessionCwd } from "./continuum.js";

export interface ScannedSession {
  sessionId: string;
  filepath: string;
  size: number;
  mtime: Date;
  cwd: string | undefined;
  name: string | undefined;          // customTitle, if set
  firstPrompt: string | undefined;   // first user message, for display
  lastEntryType: string | undefined; // for "interrupted" detection
  cleanlyEnded: boolean;             // last assistant msg has stop_reason: end_turn
}

export interface ScanOptions {
  withinHours: number;
  minSize: number;
  projectsRoot?: string;
  includeCleanlyEnded?: boolean; // default false: skip sessions that ended on end_turn
  minAgeSeconds?: number;        // default 30: skip sessions modified in last N sec ("currently typing")
  excludeCwdPatterns?: RegExp[];        // matched against decoded cwd
  excludeProjectDirPatterns?: RegExp[]; // matched against encoded project dir name (catches lossy-decoded paths)
}

/**
 * Default exclusion patterns. Match against EITHER the decoded cwd OR the
 * encoded project directory name (since paths containing UUIDs decode lossy
 * and getSessionCwd returns undefined for them).
 *
 * Targets agent-spawned sessions that should not be resumed manually:
 *   - claude-mem observer sessions
 *   - orc sub-agent worktrees
 */
export const DEFAULT_EXCLUDE_CWD: readonly RegExp[] = [
  /\/\.claude-mem\//,
  /\/\.orc\/worktrees\//,
  /\.orc\/worktrees\//,
];

export const DEFAULT_EXCLUDE_PROJECT_DIR: readonly RegExp[] = [
  /-claude-mem-/,
  /--orc-worktrees-/,
  /-\.orc-worktrees-/,
];

interface JsonlEntry {
  type?: string;
  customTitle?: string;
  cwd?: string;
  message?: {
    role?: string;
    content?: unknown;
    stop_reason?: string;
  };
}

function parseLine(line: string): JsonlEntry | null {
  try {
    return JSON.parse(line) as JsonlEntry;
  } catch {
    return null;
  }
}

function extractFirstPrompt(entry: JsonlEntry): string | undefined {
  if (entry.type !== "user" || entry.message?.role !== "user") return undefined;
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === "object" && part !== null && (part as { type?: string }).type === "text") {
        const text = (part as { text?: string }).text;
        if (typeof text === "string") return text;
      }
    }
  }
  return undefined;
}

function summarize(filepath: string): {
  name: string | undefined;
  firstPrompt: string | undefined;
  lastEntryType: string | undefined;
  cleanlyEnded: boolean;
} {
  let name: string | undefined;
  let firstPrompt: string | undefined;
  let lastEntryType: string | undefined;
  let cleanlyEnded = false;
  let lastAssistant: JsonlEntry | undefined;

  try {
    const text = readFileSync(filepath, "utf-8");
    const lines = text.split("\n");
    for (const line of lines) {
      if (!line) continue;
      const e = parseLine(line);
      if (!e) continue;
      if (!name && e.type === "queue-operation") {
        // skip — queue-operation entries don't carry a title
      }
      if (!name && e.customTitle) name = e.customTitle;
      if (!firstPrompt) {
        const p = extractFirstPrompt(e);
        if (p) firstPrompt = p;
      }
      if (e.type) lastEntryType = e.type;
      if (e.type === "assistant" || e.message?.role === "assistant") {
        lastAssistant = e;
      }
    }
    if (lastAssistant?.message?.stop_reason === "end_turn") {
      // ...but only "cleanly ended" if it's also the LAST entry, not a mid-stream turn
      const lastNonEmpty = lines.filter((l) => l.length > 0).pop();
      const lastEntry = lastNonEmpty ? parseLine(lastNonEmpty) : null;
      if (lastEntry?.message?.stop_reason === "end_turn") cleanlyEnded = true;
    }
  } catch {
    // unreadable file
  }

  return { name, firstPrompt, lastEntryType, cleanlyEnded };
}

/**
 * Find sessions modified within the cutoff. Same session ID can exist in
 * multiple project dirs (a stub + the real one); we keep only the largest per
 * ID.
 */
export function scan(opts: ScanOptions): ScannedSession[] {
  const root = opts.projectsRoot ?? join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return [];

  const cutoff = Date.now() - opts.withinHours * 3_600_000;
  const minAgeSec = opts.minAgeSeconds ?? 30;
  const youngCutoff = Date.now() - minAgeSec * 1000;
  const excludeCwd = opts.excludeCwdPatterns ?? DEFAULT_EXCLUDE_CWD;
  const excludeProjDir = opts.excludeProjectDirPatterns ?? DEFAULT_EXCLUDE_PROJECT_DIR;
  const candidates = new Map<string, ScannedSession>();

  for (const proj of readdirSync(root)) {
    if (excludeProjDir.some((re) => re.test(proj))) continue;
    const projPath = join(root, proj);
    let projStat;
    try { projStat = statSync(projPath); } catch { continue; }
    if (!projStat.isDirectory()) continue;

    let entries: string[];
    try { entries = readdirSync(projPath); } catch { continue; }

    for (const file of entries) {
      if (!file.endsWith(".jsonl")) continue;
      const sessionId = file.slice(0, -".jsonl".length);
      const fullPath = join(projPath, file);
      let stats;
      try { stats = statSync(fullPath); } catch { continue; }
      if (stats.mtimeMs < cutoff) continue;
      if (stats.mtimeMs > youngCutoff) continue; // active right now
      if (stats.size < opts.minSize) continue;

      const existing = candidates.get(sessionId);
      if (existing && existing.size >= stats.size) continue;

      const cwd = getSessionCwd(fullPath);
      if (cwd && excludeCwd.some((re) => re.test(cwd))) continue;

      const meta = summarize(fullPath);
      candidates.set(sessionId, {
        sessionId,
        filepath: fullPath,
        size: stats.size,
        mtime: stats.mtime,
        cwd,
        name: meta.name,
        firstPrompt: meta.firstPrompt,
        lastEntryType: meta.lastEntryType,
        cleanlyEnded: meta.cleanlyEnded,
      });
    }
  }

  let result = Array.from(candidates.values());
  if (!opts.includeCleanlyEnded) {
    result = result.filter((s) => !s.cleanlyEnded);
  }
  return result.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function formatAge(d: Date): string {
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export function displayName(s: ScannedSession): string {
  if (s.name) return s.name;
  if (s.firstPrompt) {
    const oneline = s.firstPrompt.replace(/\s+/g, " ").trim();
    return `"${oneline.slice(0, 50)}${oneline.length > 50 ? "…" : ""}"`;
  }
  return s.sessionId.slice(0, 8);
}

export function displayCwd(s: ScannedSession): string {
  if (!s.cwd) return "?";
  const home = homedir();
  return s.cwd.startsWith(home) ? "~" + s.cwd.slice(home.length) : s.cwd;
}
