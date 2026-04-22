import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan, displayName, displayCwd, formatAge, findRecentCluster } from "../dist/scan.js";

const fakeSession = (id, mtime) => ({
  sessionId: id, filepath: "", size: 100_000,
  mtime: typeof mtime === "number" ? new Date(mtime) : mtime,
  cwd: undefined, name: undefined, firstPrompt: undefined,
  lastEntryType: undefined, cleanlyEnded: false,
});

function makeProjects(layout) {
  const root = mkdtempSync(join(tmpdir(), "continuum-scan-"));
  for (const [projDir, files] of Object.entries(layout)) {
    const p = join(root, projDir);
    mkdirSync(p, { recursive: true });
    for (const [name, spec] of Object.entries(files)) {
      const fp = join(p, name);
      writeFileSync(fp, spec.content ?? "");
      if (spec.mtime !== undefined) {
        const t = spec.mtime / 1000;
        utimesSync(fp, t, t);
      }
    }
  }
  return root;
}

test("scan: returns empty for missing root", () => {
  assert.deepEqual(scan({ withinHours: 1, minSize: 0, projectsRoot: "/no/such" }), []);
});

test("scan: filters by withinHours", () => {
  const root = makeProjects({
    "-tmp-a": {
      "fresh.jsonl": { content: "x".repeat(60_000), mtime: Date.now() - 30 * 60_000 },
      "stale.jsonl": { content: "x".repeat(60_000), mtime: Date.now() - 5 * 3_600_000 },
    },
  });
  const out = scan({ withinHours: 1, minSize: 50_000, projectsRoot: root, minAgeSeconds: 0 });
  try {
    assert.equal(out.length, 1);
    assert.equal(out[0].sessionId, "fresh");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scan: filters by minSize (skips stubs)", () => {
  const root = makeProjects({
    "-tmp-a": {
      "stub.jsonl": { content: "tiny", mtime: Date.now() - 1000 },
      "real.jsonl": { content: "x".repeat(60_000), mtime: Date.now() - 1000 },
    },
  });
  const out = scan({ withinHours: 1, minSize: 50_000, projectsRoot: root, minAgeSeconds: 0 });
  try {
    assert.equal(out.length, 1);
    assert.equal(out[0].sessionId, "real");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scan: skips files modified within minAgeSeconds", () => {
  const root = makeProjects({
    "-tmp-a": {
      "active.jsonl": { content: "x".repeat(60_000), mtime: Date.now() - 5_000 }, // 5s old
      "stopped.jsonl": { content: "x".repeat(60_000), mtime: Date.now() - 60_000 }, // 60s old
    },
  });
  const out = scan({ withinHours: 1, minSize: 50_000, projectsRoot: root, minAgeSeconds: 30 });
  try {
    assert.equal(out.length, 1);
    assert.equal(out[0].sessionId, "stopped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scan: dedupes same session ID across project dirs (largest wins)", () => {
  const root = makeProjects({
    "-tmp-stub": {
      "shared.jsonl": { content: "tiny stub", mtime: Date.now() - 1000 },
    },
    "-tmp-real": {
      "shared.jsonl": { content: "x".repeat(80_000), mtime: Date.now() - 1000 },
    },
  });
  const out = scan({ withinHours: 1, minSize: 100, projectsRoot: root, minAgeSeconds: 0 });
  try {
    assert.equal(out.length, 1);
    assert.ok(out[0].filepath.includes("-tmp-real"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scan: extracts customTitle as name", () => {
  const root = makeProjects({
    "-tmp-a": {
      "x.jsonl": {
        content: [
          JSON.stringify({ type: "user", message: { role: "user", content: "Hi there" } }),
          JSON.stringify({ type: "custom-title", customTitle: "My Project" }),
          "x".repeat(60_000),
        ].join("\n"),
        mtime: Date.now() - 1000,
      },
    },
  });
  const out = scan({ withinHours: 1, minSize: 50_000, projectsRoot: root, minAgeSeconds: 0 });
  try {
    assert.equal(out[0].name, "My Project");
    assert.equal(displayName(out[0]), "My Project");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scan: falls back to first user prompt for display name", () => {
  const root = makeProjects({
    "-tmp-a": {
      "x.jsonl": {
        content: [
          JSON.stringify({
            type: "user",
            message: { role: "user", content: [{ type: "text", text: "Help me debug this thing" }] },
          }),
          "x".repeat(60_000),
        ].join("\n"),
        mtime: Date.now() - 1000,
      },
    },
  });
  const out = scan({ withinHours: 1, minSize: 50_000, projectsRoot: root, minAgeSeconds: 0 });
  try {
    assert.equal(displayName(out[0]), '"Help me debug this thing"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scan: skips sessions ending cleanly on end_turn", () => {
  const root = makeProjects({
    "-tmp-a": {
      "ended.jsonl": {
        content: [
          JSON.stringify({ type: "user", message: { role: "user", content: "go" } }),
          JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: "x".repeat(60_000) } }),
        ].join("\n"),
        mtime: Date.now() - 1000,
      },
      "open.jsonl": {
        content: [
          JSON.stringify({ type: "user", message: { role: "user", content: "go" } }),
          JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: "x".repeat(60_000) } }),
        ].join("\n"),
        mtime: Date.now() - 1000,
      },
    },
  });
  const out = scan({ withinHours: 1, minSize: 50_000, projectsRoot: root, minAgeSeconds: 0 });
  try {
    assert.equal(out.length, 1);
    assert.equal(out[0].sessionId, "open");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scan: --include-clean shows ended sessions too", () => {
  const root = makeProjects({
    "-tmp-a": {
      "ended.jsonl": {
        content: [
          JSON.stringify({ type: "user", message: { role: "user", content: "go" } }),
          JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: "x".repeat(60_000) } }),
        ].join("\n"),
        mtime: Date.now() - 1000,
      },
    },
  });
  const out = scan({
    withinHours: 1, minSize: 50_000, projectsRoot: root, minAgeSeconds: 0,
    includeCleanlyEnded: true,
  });
  try {
    assert.equal(out.length, 1);
    assert.equal(out[0].cleanlyEnded, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scan: excludes by project dir pattern (catches lossy-decoded UUID paths)", () => {
  const root = makeProjects({
    "-Users-h-dev-orc--orc-worktrees-abc-def": {
      "subagent.jsonl": { content: "x".repeat(60_000), mtime: Date.now() - 1000 },
    },
    "-Users-h-dev": {
      "real.jsonl": { content: "x".repeat(60_000), mtime: Date.now() - 1000 },
    },
  });
  const out = scan({ withinHours: 1, minSize: 50_000, projectsRoot: root, minAgeSeconds: 0 });
  try {
    assert.equal(out.length, 1);
    assert.equal(out[0].sessionId, "real");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("formatAge: rounds correctly across boundaries", () => {
  const now = Date.now();
  assert.match(formatAge(new Date(now - 30 * 1000)), /^\d+s ago$/);
  assert.match(formatAge(new Date(now - 5 * 60 * 1000)), /^\d+m ago$/);
  assert.match(formatAge(new Date(now - 3 * 3600 * 1000)), /^\d+h ago$/);
  assert.match(formatAge(new Date(now - 2 * 86400 * 1000)), /^\d+d ago$/);
});

test("findRecentCluster: empty input → null", () => {
  assert.equal(findRecentCluster([]), null);
});

test("findRecentCluster: single session → null (no cluster)", () => {
  assert.equal(findRecentCluster([fakeSession("a", Date.now())]), null);
});

test("findRecentCluster: 4 sessions stopped within 19s → cluster of 4", () => {
  const t = Date.now();
  const sessions = [
    fakeSession("a", t),
    fakeSession("b", t - 5_000),
    fakeSession("c", t - 12_000),
    fakeSession("d", t - 19_000),
    fakeSession("e", t - 5 * 60_000), // outlier — 5min before
  ];
  const r = findRecentCluster(sessions, 120);
  assert.ok(r);
  assert.equal(r.cluster.length, 4);
  assert.equal(r.cluster[0].sessionId, "a"); // newest first
  assert.equal(r.cluster[3].sessionId, "d");
  assert.equal(r.spreadSeconds, 19);
});

test("findRecentCluster: respects window — 30s window excludes session 60s old", () => {
  const t = Date.now();
  const sessions = [
    fakeSession("recent1", t),
    fakeSession("recent2", t - 10_000),
    fakeSession("old", t - 60_000),
  ];
  const r = findRecentCluster(sessions, 30);
  assert.ok(r);
  assert.equal(r.cluster.length, 2);
  assert.equal(r.cluster.every((s) => s.sessionId.startsWith("recent")), true);
});

test("findRecentCluster: anchors on most recent session even with shuffled input", () => {
  const t = Date.now();
  const sessions = [
    fakeSession("oldest", t - 60_000),
    fakeSession("newest", t),
    fakeSession("middle", t - 30_000),
  ];
  const r = findRecentCluster(sessions, 120);
  assert.ok(r);
  assert.equal(r.anchorMtime.getTime(), t);
});

test("findRecentCluster: minSize=3 rejects 2-session match", () => {
  const t = Date.now();
  const sessions = [
    fakeSession("a", t),
    fakeSession("b", t - 5_000),
  ];
  assert.equal(findRecentCluster(sessions, 120, 3), null);
});

test("displayCwd: replaces homedir with ~", () => {
  const home = process.env.HOME ?? "/Users/x";
  const s = { cwd: `${home}/dev/foo`, sessionId: "x", filepath: "", size: 0, mtime: new Date(), name: undefined, firstPrompt: undefined, lastEntryType: undefined, cleanlyEnded: false };
  assert.equal(displayCwd(s), "~/dev/foo");
});
