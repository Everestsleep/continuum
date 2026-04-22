import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface WatchlistEntry {
  sessionId: string;
  addedAt: string; // ISO timestamp
  note?: string;   // optional user note
}

interface WatchlistFile {
  version: 1;
  entries: WatchlistEntry[];
}

function watchlistPath(stateDir?: string): string {
  return join(stateDir ?? join(homedir(), ".continuum"), "watchlist.json");
}

export function loadWatchlist(stateDir?: string): WatchlistEntry[] {
  const f = watchlistPath(stateDir);
  if (!existsSync(f)) return [];
  try {
    const parsed = JSON.parse(readFileSync(f, "utf-8")) as WatchlistFile;
    return parsed.entries ?? [];
  } catch {
    return [];
  }
}

function saveWatchlist(entries: WatchlistEntry[], stateDir?: string): void {
  const f = watchlistPath(stateDir);
  if (!existsSync(dirname(f))) mkdirSync(dirname(f), { recursive: true });
  const data: WatchlistFile = { version: 1, entries };
  writeFileSync(f, JSON.stringify(data, null, 2));
}

export function addToWatchlist(sessionId: string, note?: string, stateDir?: string): boolean {
  const entries = loadWatchlist(stateDir);
  if (entries.some((e) => e.sessionId === sessionId)) return false;
  entries.push({ sessionId, addedAt: new Date().toISOString(), note });
  saveWatchlist(entries, stateDir);
  return true;
}

export function removeFromWatchlist(sessionId: string, stateDir?: string): boolean {
  const entries = loadWatchlist(stateDir);
  const idx = entries.findIndex((e) => e.sessionId === sessionId);
  if (idx === -1) return false;
  entries.splice(idx, 1);
  saveWatchlist(entries, stateDir);
  return true;
}

export function clearWatchlist(stateDir?: string): number {
  const entries = loadWatchlist(stateDir);
  const n = entries.length;
  saveWatchlist([], stateDir);
  return n;
}

export function isWatched(sessionId: string, stateDir?: string): boolean {
  return loadWatchlist(stateDir).some((e) => e.sessionId === sessionId);
}

export function replaceWatchlist(sessionIds: string[], stateDir?: string): void {
  const now = new Date().toISOString();
  const entries: WatchlistEntry[] = sessionIds.map((id) => ({ sessionId: id, addedAt: now }));
  saveWatchlist(entries, stateDir);
}
