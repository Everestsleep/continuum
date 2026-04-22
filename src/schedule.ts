import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Parse a time string into an absolute epoch-ms target.
 * Accepts:
 *   - "4:10am", "4:10 am", "16:10"           (next occurrence; tomorrow if past today)
 *   - "in 30m", "in 2h", "+30m", "+90s"      (relative)
 */
export function parseTime(s: string, now: Date = new Date()): number {
  const trimmed = s.trim();

  const rel = trimmed.match(/^(?:in\s+|\+)?(\d+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)$/i);
  if (rel) {
    const n = Number.parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    const seconds = unit.startsWith("s") ? n : unit.startsWith("m") ? n * 60 : n * 3600;
    return now.getTime() + seconds * 1000;
  }

  const abs = trimmed.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (abs) {
    let hour = Number.parseInt(abs[1], 10);
    const min = Number.parseInt(abs[2], 10);
    const meridiem = abs[3]?.toLowerCase();
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    if (hour < 0 || hour > 23 || min < 0 || min > 59) {
      throw new Error(`Invalid time: ${s}`);
    }
    const target = new Date(now);
    target.setHours(hour, min, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    return target.getTime();
  }

  throw new Error(`Cannot parse time: "${s}". Try "4:10am", "16:10", "in 30m", or "+90s".`);
}

export interface ScheduleResult {
  pid: number;
  logFile: string;
  targetEpochMs: number;
  delaySec: number;
}

/**
 * Schedule a deferred shell command using nohup + (on macOS) caffeinate so:
 *  - closing the terminal doesn't kill it (nohup, detached)
 *  - the machine stays awake until the timer fires (caffeinate -i)
 *
 * The shell command is run as `sh -c "<command>"`. Caller is responsible for
 * shell-quoting any args inside the command string.
 */
export function scheduleAt(timeStr: string, command: string): ScheduleResult {
  const targetMs = parseTime(timeStr);
  const delaySec = Math.max(1, Math.floor((targetMs - Date.now()) / 1000));

  const stateDir = join(homedir(), ".continuum");
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = join(stateDir, `scheduled-${stamp}.log`);

  const inner = `sleep ${delaySec} && ${command}`;
  const wrapper = process.platform === "darwin"
    ? `caffeinate -i sh -c ${shQuote(inner)}`
    : `sh -c ${shQuote(inner)}`;

  // We use spawnSync indirectly by writing an outer shell that reports the
  // detached PID. Using stdio: "ignore" + detached: true would prevent us
  // from getting the PID back.
  const wrapperScript = `nohup ${wrapper} >> ${shQuote(logFile)} 2>&1 & echo $!`;

  const result = require("node:child_process").spawnSync(
    "sh",
    ["-c", wrapperScript],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
  ) as { stdout: string };

  const pid = Number.parseInt(result.stdout.trim(), 10) || 0;
  return { pid, logFile, targetEpochMs: targetMs, delaySec };
}

export function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function formatTarget(epochMs: number): string {
  const d = new Date(epochMs);
  return d.toLocaleString("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export function formatDelay(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
