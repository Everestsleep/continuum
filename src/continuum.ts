#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export interface Options {
  sessionId: string;
  initialPrompt: string;
  compactThreshold: number;
  contextWindow: number;
  sentinel: string;
  maxIterations: number;
  model: string | undefined;
  cwd: string | undefined;
  fallbackWaitSec: number;
  permissionMode: string;
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const DEFAULTS: Omit<Options, "sessionId" | "initialPrompt"> = {
  compactThreshold: 0.8,
  contextWindow: 1_000_000,
  sentinel: "<<TASK_COMPLETE>>",
  maxIterations: Number.POSITIVE_INFINITY,
  model: undefined,
  cwd: undefined,
  fallbackWaitSec: 600,
  permissionMode: "bypassPermissions",
};

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[continuum ${ts}] ${msg}\n`);
}

export function findSessionFile(sessionId: string, cwd: string | undefined, projectsRoot?: string): string {
  const projectsDir = projectsRoot ?? join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) {
    throw new Error(`No ~/.claude/projects directory at ${projectsDir}`);
  }

  // Same session ID can exist in multiple project dirs (a small metadata stub
  // plus the real conversation). Collect all matches; prefer the largest, since
  // Claude writes a stub on resume from a different cwd.
  const matches: { path: string; size: number; encoded: string }[] = [];
  for (const dir of readdirSync(projectsDir)) {
    const path = join(projectsDir, dir, `${sessionId}.jsonl`);
    if (existsSync(path)) {
      matches.push({ path, size: statSync(path).size, encoded: dir });
    }
  }
  if (matches.length === 0) {
    throw new Error(`Session ${sessionId} not found in ~/.claude/projects/`);
  }

  if (cwd) {
    const encoded = "-" + cwd.replace(/^\//, "").replace(/\//g, "-");
    const preferred = matches.find((m) => m.encoded === encoded);
    if (preferred) return preferred.path;
  }

  matches.sort((a, b) => b.size - a.size);
  return matches[0].path;
}

export function getSessionCwd(sessionFile: string): string | undefined {
  // Preferred: decode the project dir name. Claude's `--resume` looks up
  // sessions by the CALLER's cwd → encoded project dir, so we must spawn
  // from a directory whose encoding matches the project dir of `sessionFile`,
  // regardless of what the JSONL records as the original cwd.
  // Encoding: each "/" → "-", with a leading "-" (e.g. "/Users/h/dev" → "-Users-h-dev").
  // Lossy in general, so we only return the decoded path if it exists on disk.
  const parts = sessionFile.split("/");
  const encoded = parts[parts.length - 2];
  if (encoded && encoded.startsWith("-")) {
    const decoded = "/" + encoded.slice(1).replace(/-/g, "/");
    if (existsSync(decoded)) return decoded;
  }

  // Fallback: cwd field in JSONL content (may be stale if the dir was renamed).
  if (existsSync(sessionFile) && statSync(sessionFile).size > 0) {
    const lines = readFileSync(sessionFile, "utf-8").trim().split("\n");
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as { cwd?: string };
        if (entry.cwd && existsSync(entry.cwd)) return entry.cwd;
      } catch {
        // skip malformed lines
      }
    }
  }
  return undefined;
}

export function getContextTokens(sessionFile: string): number {
  if (!existsSync(sessionFile)) return 0;
  if (statSync(sessionFile).size === 0) return 0;
  const lines = readFileSync(sessionFile, "utf-8").trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]) as { message?: { usage?: Record<string, number> } };
      const u = entry.message?.usage;
      if (!u) continue;
      const input = u.input_tokens ?? 0;
      const cacheCreate = u.cache_creation_input_tokens ?? 0;
      const cacheRead = u.cache_read_input_tokens ?? 0;
      return input + cacheCreate + cacheRead;
    } catch {
      // skip malformed lines
    }
  }
  return 0;
}

export function detectRateLimit(text: string): { hit: boolean; resetAt?: number } {
  const lower = text.toLowerCase();
  const hit =
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("usage limit") ||
    lower.includes("quota exceeded") ||
    lower.includes("\"status\":429") ||
    lower.includes("status code 429");
  if (!hit) return { hit: false };

  const epoch = text.match(/(?:reset|expires?|available|retry).{0,40}?(\d{10})/i);
  if (epoch) return { hit: true, resetAt: Number.parseInt(epoch[1], 10) };

  // Match "in 3h 45m", "in 3 hours", "in 30m", "in 30 minutes" — require at
  // least one digit-unit pair to avoid spurious matches on words like "again".
  const hAndM = text.match(/\bin\s+(\d+)\s*h(?:ours?)?(?:\s+(\d+)\s*m(?:in(?:utes?)?)?)?/i);
  const mOnly = text.match(/\bin\s+(\d+)\s*m(?:in(?:utes?)?)?\b/i);
  if (hAndM) {
    const h = Number.parseInt(hAndM[1], 10);
    const m = hAndM[2] ? Number.parseInt(hAndM[2], 10) : 0;
    return { hit: true, resetAt: Math.floor(Date.now() / 1000) + h * 3600 + m * 60 };
  }
  if (mOnly) {
    const m = Number.parseInt(mOnly[1], 10);
    return { hit: true, resetAt: Math.floor(Date.now() / 1000) + m * 60 };
  }

  const retryAfter = text.match(/retry-?after[":\s]+(\d+)/i);
  if (retryAfter) {
    return { hit: true, resetAt: Math.floor(Date.now() / 1000) + Number.parseInt(retryAfter[1], 10) };
  }

  return { hit: true };
}

function runOnce(opts: Options, prompt: string, spawnCwd: string | undefined): Promise<RunResult> {
  return new Promise((resolve) => {
    const args = ["--resume", opts.sessionId, "-p", prompt, "--permission-mode", opts.permissionMode];
    if (opts.model) args.push("--model", opts.model);

    const child = spawn("claude", args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: spawnCwd && existsSync(spawnCwd) ? spawnCwd : undefined,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      const s = d.toString();
      stdout += s;
      process.stdout.write(s);
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      process.stderr.write(s);
    });
    child.on("error", (err) => {
      resolve({ exitCode: 127, stdout, stderr: stderr + String(err) });
    });
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
  });
}

async function waitForReset(resetAt: number | undefined, fallbackSec: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  // If we successfully parsed a reset time, trust it (min 2s to avoid tight loops).
  // Otherwise use the user-controlled fallback.
  const wait = resetAt ? Math.max(resetAt - now, 2) : fallbackSec;
  const target = new Date((now + wait) * 1000).toISOString().slice(11, 19);
  log(`rate-limited; sleeping ${wait}s until ~${target} UTC`);
  await sleep(wait * 1000);
}

export async function continuum(opts: Options): Promise<number> {
  const sessionFile = findSessionFile(opts.sessionId, opts.cwd);
  const sessionCwd = opts.cwd ?? getSessionCwd(sessionFile);
  log(`session file: ${sessionFile}`);
  if (sessionCwd) {
    if (existsSync(sessionCwd)) {
      log(`spawn cwd:    ${sessionCwd}`);
    } else {
      log(`warning: session cwd ${sessionCwd} no longer exists; spawning from current dir`);
    }
  }
  log(`compact at >${(opts.compactThreshold * 100).toFixed(0)}% of ${opts.contextWindow.toLocaleString()} tokens`);
  log(`stop sentinel: ${opts.sentinel}`);

  let prompt = opts.initialPrompt;
  let iter = 0;
  let consecutiveErrors = 0;

  while (iter < opts.maxIterations) {
    iter++;
    log(`iter ${iter} | prompt: "${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}"`);
    const result = await runOnce(opts, prompt, sessionCwd);
    const combined = result.stdout + result.stderr;

    // Detect "No conversation found" — the session lives in a different CWD
    // than where we spawned claude. Surface this clearly instead of looping.
    if (combined.includes("No conversation found with session ID")) {
      log(`claude can't find session ${opts.sessionId} from cwd ${sessionCwd ?? process.cwd()}.`);
      log(`This usually means the session's original cwd no longer exists,`);
      log(`or the session is currently active in another window.`);
      return 1;
    }

    if (result.stdout.includes(opts.sentinel)) {
      log(`sentinel "${opts.sentinel}" found — stopping`);
      return 0;
    }

    const limit = detectRateLimit(combined);
    if (limit.hit) {
      await waitForReset(limit.resetAt, opts.fallbackWaitSec);
      continue;
    }

    if (result.exitCode !== 0) {
      consecutiveErrors++;
      log(`non-zero exit ${result.exitCode} (consecutive errors: ${consecutiveErrors})`);
      if (consecutiveErrors >= 3) {
        log("3 consecutive errors — bailing out");
        return result.exitCode;
      }
      await sleep(30_000);
      continue;
    }
    consecutiveErrors = 0;

    const tokens = getContextTokens(sessionFile);
    const ratio = tokens / opts.contextWindow;
    log(`context: ${tokens.toLocaleString()} tokens (${(ratio * 100).toFixed(1)}%)`);

    if (ratio >= opts.compactThreshold) {
      prompt = "/compact\n\nThen continue with the next step toward the original goal.";
    } else {
      prompt = "continue";
    }
  }

  log(`hit max iterations (${opts.maxIterations})`);
  return 0;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { ...DEFAULTS, sessionId: "", initialPrompt: "continue" };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      return v;
    };
    switch (a) {
      case "--threshold": opts.compactThreshold = Number.parseFloat(next()); break;
      case "--window": opts.contextWindow = Number.parseInt(next(), 10); break;
      case "--sentinel": opts.sentinel = next(); break;
      case "--max-iter": opts.maxIterations = Number.parseInt(next(), 10); break;
      case "--model": opts.model = next(); break;
      case "--cwd": opts.cwd = next(); break;
      case "--permission-mode": opts.permissionMode = next(); break;
      case "--fallback-wait": opts.fallbackWaitSec = Number.parseInt(next(), 10); break;
      case "-h":
      case "--help": printHelp(); process.exit(0);
      case "-v":
      case "--version": console.log(VERSION); process.exit(0);
      default:
        if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
        positional.push(a);
    }
  }
  if (positional.length < 1) {
    printHelp();
    process.exit(1);
  }
  opts.sessionId = positional[0];
  if (positional.length > 1) opts.initialPrompt = positional.slice(1).join(" ");
  return opts;
}

const VERSION = "0.1.2";

function printHelp(): void {
  process.stdout.write(`continuum ${VERSION} — auto-resume Claude Code sessions through rate limits

Usage:
  continuum <session-id> [initial-prompt]

Options:
  --threshold <0-1>       Compact when context >= this ratio (default 0.8)
  --window <n>            Context window in tokens (default 1000000)
  --sentinel <str>        Stop string the model emits when done (default <<TASK_COMPLETE>>)
  --max-iter <n>          Max iterations (default infinite)
  --model <alias>         e.g. opus, sonnet, haiku (default: session's current)
  --cwd <path>            Hint for finding session file
  --permission-mode <m>   default | acceptEdits | bypassPermissions | plan
  --fallback-wait <sec>   Wait if reset time can't be parsed (default 600)
  -h, --help              Show help
  -v, --version           Show version

Examples:
  continuum abc-123-def
  continuum abc-123-def "finish the OPS-152 task" --threshold 0.7
  continuum abc-123-def --model opus --max-iter 50

Tell the agent to emit "${DEFAULTS.sentinel}" when finished, or use --sentinel.
`);
}

// CLI dispatch lives in cli.ts. Keep a tiny entry here for backward-compat
// with anyone calling `node dist/continuum.js <session-id>` directly.
async function main(): Promise<void> {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const code = await continuum(opts);
    process.exit(code);
  } catch (err) {
    process.stderr.write(`continuum: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

const invokedAsScript = process.argv[1]?.endsWith("continuum.js") ?? false;
if (invokedAsScript) {
  main();
}
