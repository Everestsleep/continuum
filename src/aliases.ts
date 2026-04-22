import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface AliasMap { [sessionId: string]: string }

function aliasFile(stateDir: string = join(homedir(), ".continuum")): string {
  return join(stateDir, "aliases.json");
}

export function loadAliases(stateDir?: string): AliasMap {
  const f = aliasFile(stateDir);
  if (!existsSync(f)) return {};
  try {
    return JSON.parse(readFileSync(f, "utf-8")) as AliasMap;
  } catch {
    return {};
  }
}

export function saveAliases(aliases: AliasMap, stateDir?: string): void {
  const f = aliasFile(stateDir);
  if (!existsSync(dirname(f))) mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(aliases, null, 2));
}

/**
 * Resolve a partial session id to the full id by prefix-matching against the
 * given candidate list. Throws if zero or >1 match.
 */
export function resolveSessionId(prefix: string, candidates: readonly string[]): string {
  if (candidates.includes(prefix)) return prefix;
  const matches = candidates.filter((id) => id.startsWith(prefix));
  if (matches.length === 0) throw new Error(`No session matches prefix "${prefix}"`);
  if (matches.length > 1) {
    throw new Error(`Ambiguous prefix "${prefix}" matches ${matches.length} sessions; use more characters`);
  }
  return matches[0];
}

export function setAlias(sessionId: string, name: string, stateDir?: string): void {
  const aliases = loadAliases(stateDir);
  aliases[sessionId] = name;
  saveAliases(aliases, stateDir);
}

export function removeAlias(sessionId: string, stateDir?: string): boolean {
  const aliases = loadAliases(stateDir);
  if (!(sessionId in aliases)) return false;
  delete aliases[sessionId];
  saveAliases(aliases, stateDir);
  return true;
}
