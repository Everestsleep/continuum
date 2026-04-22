import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

/**
 * Candidate claude:// URL formats to probe against Claude Desktop.
 *
 * Claude Desktop registers the `claude://` scheme (CFBundleURLTypes) and has
 * an `open-url` handler plus an internal `OperonConversations.resume` method,
 * but the URL-path → handler mapping is not documented. These candidates
 * cover the common Electron deep-link patterns; whichever one focuses the
 * right session window is the one we wire into production use.
 */
export const PROBE_URLS: readonly ((id: string) => string)[] = [
  (id) => `claude://resume/${id}`,
  (id) => `claude://resume?sessionId=${id}`,
  (id) => `claude://session/${id}`,
  (id) => `claude://session?id=${id}`,
  (id) => `claude://conversation/${id}`,
  (id) => `claude://conversation?id=${id}`,
  (id) => `claude://chat?sessionId=${id}`,
  (id) => `claude://open?sessionId=${id}`,
];

export interface ProbeResult {
  url: string;
  opened: boolean;
  error?: string;
}

/** Fire `open <url>` and resolve with success/failure. Darwin-only. */
export async function openClaudeUrl(url: string): Promise<ProbeResult> {
  if (process.platform !== "darwin") {
    return { url, opened: false, error: "Only macOS is supported for now" };
  }
  return new Promise((resolve) => {
    const child = spawn("open", [url], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("close", (code) => {
      if (code === 0) resolve({ url, opened: true });
      else resolve({ url, opened: false, error: stderr.trim() || `exit ${code}` });
    });
  });
}

/**
 * Probe each candidate URL in sequence with pauses, and ask the user after
 * each one which (if any) focused the correct session window. Returns the
 * winning URL template index (or null if none worked).
 */
export async function runProbe(sessionId: string, pauseSec: number = 3): Promise<number | null> {
  stdout.write(
    `\nProbing ${PROBE_URLS.length} candidate URLs against Claude Desktop.\n` +
    `Watch your Claude Desktop app — note which probe (if any) focuses the\n` +
    `correct session window. Pauses ${pauseSec}s between each.\n\n`,
  );

  const winners: number[] = [];
  for (let i = 0; i < PROBE_URLS.length; i++) {
    const url = PROBE_URLS[i](sessionId);
    stdout.write(`  [${i + 1}/${PROBE_URLS.length}] open "${url}"\n`);
    const r = await openClaudeUrl(url);
    if (!r.opened) {
      stdout.write(`      ↳ open failed: ${r.error}\n`);
    }
    if (i < PROBE_URLS.length - 1) await sleep(pauseSec * 1000);
  }

  stdout.write(`\nAll URLs attempted. Which one focused the right session?\n`);
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const ans = await rl.question(
      `Enter probe number (1-${PROBE_URLS.length}), or 0 if none worked: `,
    );
    const n = Number.parseInt(ans.trim(), 10);
    if (!Number.isFinite(n) || n < 0 || n > PROBE_URLS.length) {
      stdout.write(`Invalid response. Aborting.\n`);
      return null;
    }
    if (n === 0) {
      stdout.write(`\nNo URL worked. Fallback plan: GUI scripting via System Events.\n`);
      return null;
    }
    const winningIndex = n - 1;
    const template = PROBE_URLS[winningIndex];
    stdout.write(
      `\nWinner: probe #${n} — "${template("<id>")}"\n` +
      `This is the template continuum should use for --via desktop.\n` +
      `Report this back to Claude so the code can hardcode it.\n`,
    );
    return winningIndex;
  } finally {
    rl.close();
  }
}

/** Fire a known-good URL template against a session (used by --via desktop). */
export async function resumeViaDesktop(sessionId: string, templateIndex: number): Promise<ProbeResult> {
  const template = PROBE_URLS[templateIndex];
  if (!template) throw new Error(`Invalid probe template index: ${templateIndex}`);
  return openClaudeUrl(template(sessionId));
}
