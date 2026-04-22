import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const continuumJs = join(here, "..", "dist", "continuum.js");
const mockClaude = join(here, "mock-claude.sh");

function runContinuum({ scriptModes, sessionId = "test-session-1", extraArgs = [] }) {
  const projectsDir = mkdtempSync(join(tmpdir(), "continuum-it-projects-"));
  const projDir = join(projectsDir, "-tmp-mockproject");
  mkdirSync(projDir, { recursive: true });
  const sessionFile = join(projDir, `${sessionId}.jsonl`);
  writeFileSync(sessionFile, "");

  const mockBinDir = mkdtempSync(join(tmpdir(), "continuum-it-bin-"));
  const claudeShim = join(mockBinDir, "claude");
  // Symlink real bash script under a name `claude` so PATH lookup finds it
  writeFileSync(
    claudeShim,
    `#!/usr/bin/env bash\nexec "${mockClaude}" "$@"\n`,
  );
  chmodSync(claudeShim, 0o755);
  chmodSync(mockClaude, 0o755);

  const scriptFile = join(mockBinDir, "modes.txt");
  writeFileSync(scriptFile, scriptModes.join("\n") + "\n");

  const result = spawnSync(
    process.execPath,
    [continuumJs, sessionId, "--cwd", "/tmp/mockproject", "--max-iter", "10", ...extraArgs],
    {
      env: {
        ...process.env,
        PATH: `${mockBinDir}:${process.env.PATH}`,
        HOME: projectsDir.replace("/.claude/projects", ""),
        MOCK_SCRIPT: scriptFile,
        MOCK_SESSION_DIR: projectsDir,
        MOCK_TOKEN_DELTA: "100000",
        // Override projects root via a hack: continuum looks under HOME/.claude/projects.
        // Easier: pass an env-aware findSessionFile path. We use a symlink trick.
      },
      timeout: 30_000,
      encoding: "utf-8",
    },
  );

  return { result, projectsDir, sessionFile };
}

// continuum looks for ~/.claude/projects — set HOME to point at a fake one
function setupHome(projectsDir) {
  const fakeHome = mkdtempSync(join(tmpdir(), "continuum-it-home-"));
  const claudeProjects = join(fakeHome, ".claude", "projects");
  mkdirSync(claudeProjects, { recursive: true });
  // copy the project subdir
  const src = projectsDir;
  // we'll just symlink
  const link = join(claudeProjects, "-tmp-mockproject");
  // Use child fs.symlink synchronously
  spawnSync("ln", ["-s", join(src, "-tmp-mockproject"), link]);
  return fakeHome;
}

function runWithFakeHome({ scriptModes, sessionId = "test-session-1", extraArgs = [] }) {
  const projectsDir = mkdtempSync(join(tmpdir(), "continuum-it-projects-"));
  const projDir = join(projectsDir, "-tmp-mockproject");
  mkdirSync(projDir, { recursive: true });
  const sessionFile = join(projDir, `${sessionId}.jsonl`);
  writeFileSync(sessionFile, "");

  const fakeHome = setupHome(projectsDir);

  const mockBinDir = mkdtempSync(join(tmpdir(), "continuum-it-bin-"));
  const claudeShim = join(mockBinDir, "claude");
  writeFileSync(
    claudeShim,
    `#!/usr/bin/env bash\nexec "${mockClaude}" "$@"\n`,
  );
  chmodSync(claudeShim, 0o755);
  chmodSync(mockClaude, 0o755);

  const scriptFile = join(mockBinDir, "modes.txt");
  writeFileSync(scriptFile, scriptModes.join("\n") + "\n");

  const result = spawnSync(
    process.execPath,
    [continuumJs, sessionId, "--max-iter", "10", "--fallback-wait", "1", ...extraArgs],
    {
      env: {
        ...process.env,
        PATH: `${mockBinDir}:${process.env.PATH}`,
        HOME: fakeHome,
        MOCK_SCRIPT: scriptFile,
        MOCK_SESSION_DIR: projectsDir,
        MOCK_TOKEN_DELTA: "100000",
      },
      timeout: 30_000,
      encoding: "utf-8",
    },
  );

  return { result, projectsDir, sessionFile, fakeHome };
}

test("integration: stops on sentinel after one normal turn", () => {
  const { result } = runWithFakeHome({
    scriptModes: ["NORMAL", "SENTINEL"],
  });
  if (result.status !== 0) {
    console.error("STDOUT:", result.stdout);
    console.error("STDERR:", result.stderr);
  }
  assert.equal(result.status, 0, "should exit 0");
  assert.match(result.stderr, /sentinel.*stopping/);
  assert.match(result.stdout, /<<TASK_COMPLETE>>/);
  // Should have run exactly 2 iterations
  const iterMatches = result.stderr.match(/iter \d+/g) || [];
  assert.equal(iterMatches.length, 2, "should run 2 iterations");
});

test("integration: injects /compact when context exceeds threshold", () => {
  // 100k tokens per turn; threshold 0.15 of 1M = 150k; should compact on iter 2
  const { result } = runWithFakeHome({
    scriptModes: ["NORMAL", "NORMAL", "SENTINEL"],
    extraArgs: ["--threshold", "0.15"],
  });
  if (result.status !== 0) {
    console.error("STDOUT:", result.stdout);
    console.error("STDERR:", result.stderr);
  }
  assert.equal(result.status, 0);
  // The third iteration's prompt should contain /compact
  assert.match(result.stderr, /iter 3 \| prompt: "\/compact/);
});

test("integration: retries after rate-limit", () => {
  const { result } = runWithFakeHome({
    scriptModes: ["NORMAL", "RATELIMIT", "SENTINEL"],
    extraArgs: ["--fallback-wait", "1"],
  });
  if (result.status !== 0) {
    console.error("STDOUT:", result.stdout);
    console.error("STDERR:", result.stderr);
  }
  assert.equal(result.status, 0);
  assert.match(result.stderr, /rate-limited; sleeping/);
  // Should reach iteration 3 (NORMAL → RATELIMIT-retry → SENTINEL)
  const iterMatches = result.stderr.match(/iter \d+/g) || [];
  assert.ok(iterMatches.length >= 3, `expected >=3 iterations, got ${iterMatches.length}`);
});

test("integration: respects --max-iter cap", () => {
  // No SENTINEL → would loop forever; cap stops it at 3
  const { result } = runWithFakeHome({
    scriptModes: ["NORMAL", "NORMAL", "NORMAL", "NORMAL", "NORMAL"],
    extraArgs: ["--max-iter", "3"],
  });
  if (result.status !== 0) {
    console.error("STDOUT:", result.stdout);
    console.error("STDERR:", result.stderr);
  }
  assert.equal(result.status, 0);
  assert.match(result.stderr, /hit max iterations \(3\)/);
});
