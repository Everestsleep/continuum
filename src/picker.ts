import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { displayName, displayCwd, formatAge, formatSize, type ScannedSession } from "./scan.js";

/**
 * Parse selection input into a set of 1-based indices.
 * Accepts: "1,3,5", "1-3", "1-3,5", "all", "none", empty.
 * Throws on invalid syntax or out-of-range indices.
 */
export function parseSelection(input: string, count: number): number[] {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "" || trimmed === "none") return [];
  if (trimmed === "all" || trimmed === "*") {
    return Array.from({ length: count }, (_, i) => i + 1);
  }

  const picked = new Set<number>();
  for (const partRaw of trimmed.split(/[,\s]+/)) {
    const part = partRaw.trim();
    if (!part) continue;
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const lo = Number.parseInt(range[1], 10);
      const hi = Number.parseInt(range[2], 10);
      if (lo < 1 || hi > count || lo > hi) {
        throw new Error(`Range ${part} out of bounds (1-${count})`);
      }
      for (let i = lo; i <= hi; i++) picked.add(i);
      continue;
    }
    const single = part.match(/^(\d+)$/);
    if (single) {
      const n = Number.parseInt(single[1], 10);
      if (n < 1 || n > count) {
        throw new Error(`Index ${n} out of bounds (1-${count})`);
      }
      picked.add(n);
      continue;
    }
    throw new Error(`Bad selection token: "${part}"`);
  }
  return Array.from(picked).sort((a, b) => a - b);
}

/** Filter sessions by ID prefixes (e.g. "abc" matches "abc-123-...") */
export function filterByIds(sessions: ScannedSession[], idPrefixes: string[]): ScannedSession[] {
  if (idPrefixes.length === 0) return sessions;
  return sessions.filter((s) => idPrefixes.some((p) => s.sessionId.startsWith(p)));
}

/** Filter sessions by case-insensitive name substring match */
export function filterByNames(sessions: ScannedSession[], namePatterns: string[]): ScannedSession[] {
  if (namePatterns.length === 0) return sessions;
  const lcPatterns = namePatterns.map((p) => p.toLowerCase());
  return sessions.filter((s) => {
    const hay = displayName(s).toLowerCase();
    return lcPatterns.some((p) => hay.includes(p));
  });
}

/** Print the numbered list to stdout (used by both `scan` and the picker) */
export function printList(sessions: ScannedSession[]): void {
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const status = s.cleanlyEnded ? "[done]" : "[open]";
    stdout.write(
      `  ${String(i + 1).padStart(2)}. ${status} ${displayName(s)}\n` +
      `      cwd: ${displayCwd(s)}  (${formatSize(s.size)}, ${formatAge(s.mtime)})\n` +
      `      id:  ${s.sessionId}\n`,
    );
  }
}

/**
 * Show the list and prompt the user to select indices interactively.
 * Returns the selected sessions (in display order). Falls back to `[]` on
 * non-TTY stdin.
 */
export async function pickInteractive(sessions: ScannedSession[]): Promise<ScannedSession[]> {
  if (!stdin.isTTY) {
    stdout.write("(--pick requires an interactive terminal — got non-TTY stdin; selecting none)\n");
    return [];
  }
  if (sessions.length === 0) return [];

  printList(sessions);
  stdout.write("\n");

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const ans = await rl.question(
        `Pick which to resume (e.g. "1,3,5", "1-3", "all", "none"): `,
      );
      try {
        const indices = parseSelection(ans, sessions.length);
        if (indices.length === 0) {
          stdout.write("Selected: (none)\n");
          return [];
        }
        const picked = indices.map((i) => sessions[i - 1]);
        stdout.write(`Selected: ${picked.map((s) => displayName(s)).join(", ")}\n`);
        return picked;
      } catch (err) {
        stdout.write(`  ${err instanceof Error ? err.message : String(err)} — try again.\n`);
      }
    }
  } finally {
    rl.close();
  }
}
