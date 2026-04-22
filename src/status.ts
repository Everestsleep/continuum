import { homedir } from "node:os";
import { activeNow, displayCwd, displayName, findRecentCluster, formatAge, formatSize, scan, type ScannedSession } from "./scan.js";
import { loadAliases } from "./aliases.js";

export interface StatusFlags {
  withinHours: number;
  clusterWindowSec: number;
  minSizeKB: number;
  includeCleanlyEnded: boolean;
}

/** Print a human-readable status report with cluster detection + action plan. */
export function printStatus(flags: StatusFlags): number {
  const now = new Date();
  const nowStr = now.toLocaleString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  process.stdout.write(`\nStatus as of ${nowStr}\n`);
  process.stdout.write(`${"═".repeat(60)}\n`);

  const sessions = scan({
    withinHours: flags.withinHours,
    minSize: flags.minSizeKB * 1024,
    includeCleanlyEnded: flags.includeCleanlyEnded,
  });

  if (sessions.length === 0) {
    process.stdout.write(`\nNo interrupted sessions in the last ${flags.withinHours}h.\n`);
    process.stdout.write(`Nothing to do. :)\n\n`);
    return 0;
  }

  const aliases = loadAliases();
  const active = activeNow(sessions);
  const cluster = findRecentCluster(sessions, flags.clusterWindowSec);

  if (active.length > 0) {
    process.stdout.write(`\n● Currently active (modified in last 5 min): ${active.length} session(s)\n`);
    for (let i = 0; i < Math.min(active.length, 5); i++) {
      const s = active[i];
      process.stdout.write(`    ${displayName(s, aliases)}  (${formatAge(s.mtime)})\n`);
    }
    if (active.length > 5) process.stdout.write(`    … and ${active.length - 5} more\n`);
    process.stdout.write(`  These are still being typed in — leaving them alone.\n`);
  }

  if (cluster) {
    const whenTime = cluster.anchorMtime.toLocaleString("en-US", {
      weekday: "short", hour: "numeric", minute: "2-digit", hour12: true,
    });
    const whenAgo = formatAge(cluster.anchorMtime);
    process.stdout.write(`\n⚠  Likely rate-limit cluster detected\n`);
    process.stdout.write(
      `   ${cluster.cluster.length} session(s) stopped within ${cluster.spreadSeconds}s ` +
      `around ${whenTime} (${whenAgo}).\n`,
    );
    process.stdout.write(`   This is the signature of a 5h-limit hit.\n\n`);
    process.stdout.write(`Sessions in cluster:\n`);
    for (let i = 0; i < cluster.cluster.length; i++) {
      const s = cluster.cluster[i];
      const aliased = aliases[s.sessionId] ? " *" : "";
      process.stdout.write(
        `  ${i + 1}. ${displayName(s, aliases)}${aliased}\n` +
        `     ${displayCwd(s)}  (${formatSize(s.size)}, last ${formatAge(s.mtime)})\n`,
      );
    }
    process.stdout.write(`\n`);
    printPlan(cluster.cluster, /*isCluster*/ true);
  } else if (active.length === sessions.length) {
    process.stdout.write(`\nNothing stopped — every recent session is currently active.\n`);
    process.stdout.write(`No resume needed. :)\n\n`);
    return 0;
  } else {
    process.stdout.write(`\nFound ${sessions.length - active.length} stopped session(s), but no tight cluster.\n`);
    process.stdout.write(`Either only one stopped, or they stopped at different times (not a rate-limit pattern).\n\n`);
    process.stdout.write(`Recent sessions:\n`);
    for (let i = 0; i < Math.min(sessions.length, 5); i++) {
      const s = sessions[i];
      const aliased = aliases[s.sessionId] ? " *" : "";
      process.stdout.write(
        `  ${i + 1}. ${displayName(s, aliases)}${aliased}  (${formatAge(s.mtime)})\n`,
      );
    }
    process.stdout.write(`\n`);
    printPlan(sessions.slice(0, 5), /*isCluster*/ false);
  }

  if (Object.keys(aliases).length > 0) {
    process.stdout.write(`  * = aliased via "continuum name"\n\n`);
  }

  return 0;
}

function printPlan(sessions: ScannedSession[], isCluster: boolean): void {
  process.stdout.write(`Recommended:\n`);
  if (isCluster) {
    process.stdout.write(`  → If your limit has already lifted, resume all of them now:\n`);
    process.stdout.write(`      continuum resume-all --yes\n\n`);
    process.stdout.write(`  → If your limit lifts later (e.g. at 4:10am):\n`);
    process.stdout.write(`      continuum resume-all --at 4:10am\n\n`);
    process.stdout.write(`  → To pick a subset interactively:\n`);
    process.stdout.write(`      continuum resume-all --pick\n\n`);
  } else {
    process.stdout.write(`  → See the full list:\n`);
    process.stdout.write(`      continuum scan\n\n`);
    process.stdout.write(`  → Resume a specific one:\n`);
    process.stdout.write(`      continuum <session-id>\n\n`);
  }
  process.stdout.write(`  → Dry-run first (shows what would fire, runs nothing):\n`);
  process.stdout.write(`      continuum resume-all --dry-run\n\n`);
}
