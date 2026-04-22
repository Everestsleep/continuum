#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { continuum, type Options as RunOpts } from "./continuum.js";
import { displayCwd, displayName, findRecentCluster, formatAge, formatSize, scan, type ScannedSession } from "./scan.js";
import { filterByIds, filterByNames, pickInteractive, printList } from "./picker.js";
import { formatDelay, formatTarget, scheduleAt, shQuote } from "./schedule.js";
import { loadAliases, removeAlias, resolveSessionId, setAlias } from "./aliases.js";
import { printStatus } from "./status.js";
import { PROBE_URLS, runProbe } from "./desktop.js";

const VERSION = "0.4.1";

function printRootHelp(): void {
  process.stdout.write(`continuum ${VERSION} — keep Claude Code sessions running through rate limits

Usage:
  continuum status [--within Nh]
      One-pager: cluster detection + named sessions + action plan.
      Best place to start — shows you what happened and what to run next.

  continuum scan [--within Nh]
      List interrupted sessions. Default: last 1 hour.

  continuum desktop-probe <session-id>
      Probe 8 candidate claude:// URLs against Claude Desktop to find the
      one that focuses a session window. macOS only.

  continuum resume-all [--at <time>] [--within Nh]
                       [--pick | --only <sel> | --yes] [--dry-run]
      Resume every interrupted session. By default, prompts you to pick.
      With --at, schedules a one-shot via nohup + caffeinate (survives
      terminal close, keeps Mac awake). With --only "1,3,5" or
      "name,prefix" you can pre-select non-interactively. --yes resumes
      all without asking.

  continuum name <id-prefix> "<name>"
      Set a friendly alias for a session (stored in ~/.continuum/aliases.json).
      Alias takes precedence over the session's customTitle in scan output.

  continuum unname <id-prefix>
      Remove the alias for a session.

  continuum <session-id> [initial-prompt]
      Run the resume loop on one session (auto-compact at 80%, retry
      through rate limits, stop on <<TASK_COMPLETE>>).

  continuum -h | --help     Show help
  continuum -v | --version  Show version

Examples:
  continuum scan
  continuum name 9c78a41a "Anterior Implant Lead Magnet"
  continuum resume-all                       # interactive picker
  continuum resume-all --at 4:10am           # picker + schedule
  continuum resume-all --only "1,3,5" --at 4:10am
  continuum resume-all --only "Cinema,Note Generator" --at 4:10am
  continuum resume-all --yes --at "in 30m"   # all, no prompt
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
  cluster: boolean;
  clusterWindowSec: number;
}

function parseScanFlags(argv: string[]): ScanFlags {
  const flags: ScanFlags = {
    withinHours: 1, minSizeKB: 50, includeCleanlyEnded: false,
    cluster: false, clusterWindowSec: 120,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--within": flags.withinHours = parseHours(argv[++i]); break;
      case "--min-size-kb": flags.minSizeKB = Number.parseInt(argv[++i], 10); break;
      case "--include-clean": flags.includeCleanlyEnded = true; break;
      case "--cluster": flags.cluster = true; break;
      case "--cluster-window": flags.clusterWindowSec = Number.parseInt(argv[++i], 10); break;
      default:
        if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    }
  }
  return flags;
}

function printSession(s: ScannedSession, idx: number, aliases: Record<string, string>): void {
  const status = s.cleanlyEnded ? "[done]" : "[open]";
  const name = displayName(s, aliases);
  const aliased = aliases[s.sessionId] ? " *" : "";
  const cwd = displayCwd(s);
  process.stdout.write(
    `  ${String(idx + 1).padStart(2)}. ${status} ${name}${aliased}\n` +
    `      cwd: ${cwd}  (${formatSize(s.size)}, ${formatAge(s.mtime)})\n` +
    `      id:  ${s.sessionId}\n`,
  );
}

function cmdScan(argv: string[]): number {
  const flags = parseScanFlags(argv);
  let sessions = scan({
    withinHours: flags.withinHours,
    minSize: flags.minSizeKB * 1024,
    includeCleanlyEnded: flags.includeCleanlyEnded,
  });
  if (sessions.length === 0) {
    process.stdout.write(`No interrupted sessions in the last ${flags.withinHours}h.\n`);
    return 0;
  }
  const aliases = loadAliases();

  if (flags.cluster) {
    const result = findRecentCluster(sessions, flags.clusterWindowSec);
    if (!result) {
      process.stdout.write(
        `No cluster of >=2 sessions stopping within ${flags.clusterWindowSec}s found.\n` +
        `(All recent sessions stopped at distinct times — probably not a rate-limit event.)\n`,
      );
      return 0;
    }
    sessions = result.cluster;
    const when = result.anchorMtime.toLocaleString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
    process.stdout.write(
      `Cluster: ${sessions.length} session(s) stopped within ${result.spreadSeconds}s ` +
      `around ${when} — likely the rate-limit moment.\n\n`,
    );
  } else {
    process.stdout.write(`Found ${sessions.length} interrupted session(s) in last ${flags.withinHours}h:\n\n`);
  }
  sessions.forEach((s, i) => printSession(s, i, aliases));
  if (Object.keys(aliases).length > 0) {
    process.stdout.write(`\n  * = aliased via "continuum name"\n`);
  }
  return 0;
}

interface ResumeAllFlags extends ScanFlags {
  at: string | undefined;
  yes: boolean;
  dryRun: boolean;
  pick: boolean;
  names: string[];
  idPrefixes: string[];
  noCluster: boolean;
}

function parseResumeAllFlags(argv: string[]): ResumeAllFlags {
  const flags: ResumeAllFlags = {
    withinHours: 1,
    minSizeKB: 50,
    includeCleanlyEnded: false,
    cluster: true, // default ON for resume-all
    clusterWindowSec: 120,
    at: undefined,
    yes: false,
    dryRun: false,
    pick: false,
    names: [],
    idPrefixes: [],
    noCluster: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--within": flags.withinHours = parseHours(argv[++i]); break;
      case "--min-size-kb": flags.minSizeKB = Number.parseInt(argv[++i], 10); break;
      case "--include-clean": flags.includeCleanlyEnded = true; break;
      case "--cluster-window": flags.clusterWindowSec = Number.parseInt(argv[++i], 10); break;
      case "--no-cluster": flags.noCluster = true; flags.cluster = false; break;
      case "--at": flags.at = argv[++i]; break;
      case "--yes": case "-y": flags.yes = true; break;
      case "--dry-run": flags.dryRun = true; break;
      case "--pick": flags.pick = true; break;
      case "--name": flags.names.push(argv[++i]); break;
      case "--id": flags.idPrefixes.push(argv[++i]); break;
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

function cmdName(argv: string[]): number {
  if (argv.length < 2) {
    process.stderr.write(`Usage: continuum name <id-prefix> "<name>"\n`);
    return 1;
  }
  const prefix = argv[0];
  const name = argv.slice(1).join(" ");
  // Resolve prefix against currently-known sessions (within 24h to be safe)
  const sessions = scan({ withinHours: 24 * 30, minSize: 0, minAgeSeconds: 0 });
  const ids = sessions.map((s) => s.sessionId);
  const fullId = resolveSessionId(prefix, ids);
  setAlias(fullId, name);
  process.stdout.write(`Aliased ${fullId} → "${name}"\n`);
  return 0;
}

function cmdUnname(argv: string[]): number {
  if (argv.length < 1) {
    process.stderr.write(`Usage: continuum unname <id-prefix>\n`);
    return 1;
  }
  const prefix = argv[0];
  const aliases = loadAliases();
  const fullId = resolveSessionId(prefix, Object.keys(aliases));
  if (removeAlias(fullId)) {
    process.stdout.write(`Removed alias for ${fullId}\n`);
    return 0;
  }
  process.stdout.write(`No alias found for ${fullId}\n`);
  return 1;
}

async function cmdResumeAll(argv: string[]): Promise<number> {
  const flags = parseResumeAllFlags(argv);
  let sessions = scan({
    withinHours: flags.withinHours,
    minSize: flags.minSizeKB * 1024,
    includeCleanlyEnded: flags.includeCleanlyEnded,
  });

  if (sessions.length === 0) {
    process.stdout.write(`No interrupted sessions in the last ${flags.withinHours}h.\n`);
    return 0;
  }

  // Default: narrow to the most recent cluster (the rate-limit moment).
  // Use --no-cluster to disable.
  if (!flags.noCluster) {
    const result = findRecentCluster(sessions, flags.clusterWindowSec);
    if (result) {
      const when = result.anchorMtime.toLocaleString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
      process.stdout.write(
        `Cluster: ${result.cluster.length} session(s) stopped within ${result.spreadSeconds}s ` +
        `around ${when} — likely the rate-limit moment.\n` +
        `(use --no-cluster to include all interrupted sessions in the window)\n\n`,
      );
      sessions = result.cluster;
    } else {
      process.stdout.write(
        `No cluster found — sessions stopped at distinct times. Showing all interrupted.\n` +
        `(use --cluster-window <sec> to widen the cluster definition)\n\n`,
      );
    }
  }

  // Apply additional filters in order: name substring → id prefix → interactive pick.
  if (flags.names.length > 0) {
    sessions = filterByNames(sessions, flags.names);
    if (sessions.length === 0) {
      process.stdout.write(`No sessions match --name filters: ${flags.names.join(", ")}\n`);
      return 0;
    }
  }
  if (flags.idPrefixes.length > 0) {
    sessions = filterByIds(sessions, flags.idPrefixes);
    if (sessions.length === 0) {
      process.stdout.write(`No sessions match --id prefixes: ${flags.idPrefixes.join(", ")}\n`);
      return 0;
    }
  }

  process.stdout.write(`Found ${sessions.length} interrupted session(s):\n\n`);
  printList(sessions);
  process.stdout.write("\n");

  if (flags.pick) {
    sessions = await pickInteractive(sessions);
    if (sessions.length === 0) {
      process.stdout.write("Nothing selected. Exiting.\n");
      return 0;
    }
    process.stdout.write("\n");
  }

  if (flags.dryRun) {
    process.stdout.write("(--dry-run: not resuming)\n");
    return 0;
  }

  if (flags.at) {
    // Schedule a deferred resume-all with --yes + per-session --id flags so
    // the same selection fires later (no second pick prompt at run time).
    const bin = continuumBinPath();
    const childArgs = [
      "resume-all",
      "--within", `${flags.withinHours}h`,
      "--min-size-kb", String(flags.minSizeKB),
      "--no-cluster",  // we already chose the IDs; don't re-cluster at fire time
      "--yes",
    ];
    if (flags.includeCleanlyEnded) childArgs.push("--include-clean");
    for (const s of sessions) childArgs.push("--id", s.sessionId);
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
    process.stdout.write("Pass --yes to actually resume them, --pick to choose, or --at <time> to schedule.\n");
    return 0;
  }

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
    if (sub === "status") {
      const flags = parseScanFlags(argv.slice(1));
      process.exit(printStatus({
        withinHours: flags.withinHours,
        clusterWindowSec: flags.clusterWindowSec,
        minSizeKB: flags.minSizeKB,
        includeCleanlyEnded: flags.includeCleanlyEnded,
      }));
    } else if (sub === "scan") {
      process.exit(cmdScan(argv.slice(1)));
    } else if (sub === "resume-all") {
      process.exit(await cmdResumeAll(argv.slice(1)));
    } else if (sub === "name") {
      process.exit(cmdName(argv.slice(1)));
    } else if (sub === "unname") {
      process.exit(cmdUnname(argv.slice(1)));
    } else if (sub === "desktop-probe") {
      const id = argv[1];
      if (!id) {
        process.stderr.write(`Usage: continuum desktop-probe <session-id>\n`);
        process.exit(1);
      }
      const idx = await runProbe(id);
      process.exit(idx === null ? 1 : 0);
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
