#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { continuum, type Options as RunOpts } from "./continuum.js";
import { displayCwd, displayName, formatAge, formatSize, scan, type ScannedSession } from "./scan.js";
import { formatDelay, formatTarget, scheduleAt, shQuote } from "./schedule.js";

const VERSION = "0.2.0";

function printRootHelp(): void {
  process.stdout.write(`continuum ${VERSION} — keep Claude Code sessions running through rate limits

Usage:
  continuum scan [--within Nh]
      List recently-active sessions that didn't end cleanly. Best proxy
      for "sessions that got cut off by a rate limit" — Claude Code
      doesn't write the 429 to the JSONL, so true rate-limit detection
      isn't possible from disk alone.

  continuum resume-all [--at <time>] [--within Nh] [--yes] [--dry-run]
      Resume every session scan would list. With --at, schedules itself
      for that time using nohup + caffeinate (survives terminal close
      and prevents idle sleep). Without --at, runs immediately.

  continuum <session-id> [initial-prompt]
      Run the resume loop on one session (auto-compact at 80%, retry
      through rate limits, stop on <<TASK_COMPLETE>>).

  continuum -h | --help     Show help
  continuum -v | --version  Show version

Examples:
  continuum scan
  continuum scan --within 6h
  continuum resume-all --at 4:10am
  continuum resume-all --at "in 30m" --yes
  continuum abc-123-def "finish the task"
`);
}

function parseRunArgs(argv: string[]): RunOpts {
  const opts: RunOpts = {
    sessionId: "",
    initialPrompt: "continue",
    compactThreshold: 0.8,
    contextWindow: 1_000_000,
    sentinel: "<<TASK_COMPLETE>>",
    maxIterations: Number.POSITIVE_INFINITY,
    model: undefined,
    cwd: undefined,
    fallbackWaitSec: 600,
    permissionMode: "bypassPermissions",
  };
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
      default:
        if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
        positional.push(a);
    }
  }
  if (positional.length < 1) throw new Error("session id required");
  opts.sessionId = positional[0];
  if (positional.length > 1) opts.initialPrompt = positional.slice(1).join(" ");
  return opts;
}

function parseHours(s: string): number {
  const m = s.match(/^(\d+)\s*h?$/i);
  if (!m) throw new Error(`--within wants e.g. "1h", "6h" — got "${s}"`);
  return Number.parseInt(m[1], 10);
}

interface ScanFlags {
  withinHours: number;
  minSizeKB: number;
  includeCleanlyEnded: boolean;
}

function parseScanFlags(argv: string[]): ScanFlags {
  const flags: ScanFlags = { withinHours: 1, minSizeKB: 50, includeCleanlyEnded: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--within": flags.withinHours = parseHours(argv[++i]); break;
      case "--min-size-kb": flags.minSizeKB = Number.parseInt(argv[++i], 10); break;
      case "--include-clean": flags.includeCleanlyEnded = true; break;
      default:
        if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    }
  }
  return flags;
}

function printSession(s: ScannedSession, idx: number): void {
  const status = s.cleanlyEnded ? "[done]" : "[open]";
  const name = displayName(s);
  const cwd = displayCwd(s);
  process.stdout.write(
    `  ${String(idx + 1).padStart(2)}. ${status} ${name}\n` +
    `      cwd: ${cwd}  (${formatSize(s.size)}, ${formatAge(s.mtime)})\n` +
    `      id:  ${s.sessionId}\n`,
  );
}

function cmdScan(argv: string[]): number {
  const flags = parseScanFlags(argv);
  const sessions = scan({
    withinHours: flags.withinHours,
    minSize: flags.minSizeKB * 1024,
    includeCleanlyEnded: flags.includeCleanlyEnded,
  });
  if (sessions.length === 0) {
    process.stdout.write(`No interrupted sessions in the last ${flags.withinHours}h.\n`);
    return 0;
  }
  process.stdout.write(`Found ${sessions.length} interrupted session(s) in last ${flags.withinHours}h:\n\n`);
  sessions.forEach((s, i) => printSession(s, i));
  return 0;
}

interface ResumeAllFlags extends ScanFlags {
  at: string | undefined;
  yes: boolean;
  dryRun: boolean;
}

function parseResumeAllFlags(argv: string[]): ResumeAllFlags {
  const flags: ResumeAllFlags = {
    withinHours: 1,
    minSizeKB: 50,
    includeCleanlyEnded: false,
    at: undefined,
    yes: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--within": flags.withinHours = parseHours(argv[++i]); break;
      case "--min-size-kb": flags.minSizeKB = Number.parseInt(argv[++i], 10); break;
      case "--include-clean": flags.includeCleanlyEnded = true; break;
      case "--at": flags.at = argv[++i]; break;
      case "--yes": case "-y": flags.yes = true; break;
      case "--dry-run": flags.dryRun = true; break;
      default:
        if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    }
  }
  return flags;
}

function continuumBinPath(): string {
  // process.argv[1] is the entry script. realpath it so we follow the symlink
  // ~/.local/bin/continuum → ~/.continuum/dist/continuum.js (or wherever).
  const entry = process.argv[1] ?? "";
  try {
    return realpathSync(entry);
  } catch {
    return entry;
  }
}

function cmdResumeAll(argv: string[]): number {
  const flags = parseResumeAllFlags(argv);
  const sessions = scan({
    withinHours: flags.withinHours,
    minSize: flags.minSizeKB * 1024,
    includeCleanlyEnded: flags.includeCleanlyEnded,
  });

  if (sessions.length === 0) {
    process.stdout.write(`No interrupted sessions in the last ${flags.withinHours}h.\n`);
    return 0;
  }

  process.stdout.write(`Found ${sessions.length} interrupted session(s):\n\n`);
  sessions.forEach((s, i) => printSession(s, i));
  process.stdout.write("\n");

  if (flags.dryRun) {
    process.stdout.write("(--dry-run: not resuming)\n");
    return 0;
  }

  if (flags.at) {
    // Schedule a deferred resume-all without --at, with --yes so it doesn't re-prompt.
    const bin = continuumBinPath();
    const childArgs = [
      "resume-all",
      "--within", `${flags.withinHours}h`,
      "--min-size-kb", String(flags.minSizeKB),
      "--yes",
    ];
    if (flags.includeCleanlyEnded) childArgs.push("--include-clean");
    const cmd = `node ${shQuote(bin)} ${childArgs.map((a) => shQuote(a)).join(" ")}`;
    const result = scheduleAt(flags.at, cmd);
    process.stdout.write(
      `Scheduled to resume ${sessions.length} session(s) at ${formatTarget(result.targetEpochMs)} ` +
      `(in ${formatDelay(result.delaySec)}).\n` +
      `  PID:    ${result.pid}\n` +
      `  Log:    ${result.logFile}\n` +
      `  Cancel: kill ${result.pid}\n` +
      `\nSafe to close this terminal — caffeinate keeps the machine awake until then.\n`,
    );
    return 0;
  }

  if (!flags.yes) {
    process.stdout.write("Pass --yes to actually resume them, or --at <time> to schedule.\n");
    return 0;
  }

  // Resume all NOW (sequentially — safer than parallel, avoids hammering API)
  return runResumeAllNow(sessions);
}

function runResumeAllNow(sessions: ScannedSession[]): number {
  const bin = continuumBinPath();
  process.stdout.write(`Resuming ${sessions.length} session(s) sequentially.\n`);
  let exitCode = 0;
  let i = 0;

  const next = (): void => {
    if (i >= sessions.length) {
      process.stdout.write(`\nAll ${sessions.length} resume passes complete (last exit ${exitCode}).\n`);
      process.exit(exitCode);
    }
    const s = sessions[i++];
    process.stdout.write(`\n=== [${i}/${sessions.length}] ${displayName(s)} (${s.sessionId}) ===\n`);
    const child = spawn(
      "node",
      [bin, s.sessionId],
      { stdio: "inherit", env: process.env },
    );
    child.on("close", (code) => {
      exitCode = code ?? 0;
      next();
    });
  };
  next();
  return 0;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    printRootHelp();
    process.exit(argv.length === 0 ? 1 : 0);
  }
  if (argv[0] === "-v" || argv[0] === "--version") {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }

  const sub = argv[0];
  try {
    if (sub === "scan") {
      process.exit(cmdScan(argv.slice(1)));
    } else if (sub === "resume-all") {
      process.exit(cmdResumeAll(argv.slice(1)));
    } else {
      // Backward-compat: bare invocation `continuum <session-id>` runs the loop.
      const opts = parseRunArgs(argv);
      const code = await continuum(opts);
      process.exit(code);
    }
  } catch (err) {
    process.stderr.write(`continuum: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

// Direct CLI entry detection. The compiled output is CJS so we can't use
// import.meta — match against argv[1] instead.
const invokedAsScript = process.argv[1] && (
  process.argv[1].endsWith("cli.js") || process.argv[1].endsWith("continuum")
);
if (invokedAsScript) {
  main();
}
