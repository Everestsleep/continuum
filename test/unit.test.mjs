import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectRateLimit,
  getContextTokens,
  findSessionFile,
} from "../dist/continuum.js";

test("detectRateLimit: clean text → not limited", () => {
  const r = detectRateLimit("everything is fine, here is some output");
  assert.equal(r.hit, false);
});

test("detectRateLimit: 'rate limit' phrase → limited", () => {
  const r = detectRateLimit("Error: rate limit exceeded");
  assert.equal(r.hit, true);
});

test("detectRateLimit: epoch reset → parsed", () => {
  const r = detectRateLimit("rate limit. reset 1900000000");
  assert.equal(r.hit, true);
  assert.equal(r.resetAt, 1900000000);
});

test("detectRateLimit: 'in 3h 45m' → relative", () => {
  const before = Math.floor(Date.now() / 1000);
  const r = detectRateLimit("rate limit hit. try again in 3h 45m");
  const after = Math.floor(Date.now() / 1000);
  assert.equal(r.hit, true);
  assert.ok(r.resetAt);
  assert.ok(r.resetAt >= before + 13500 && r.resetAt <= after + 13500 + 1);
});

test("detectRateLimit: 'in 30 minutes' → relative", () => {
  const before = Math.floor(Date.now() / 1000);
  const r = detectRateLimit("usage limit. try again in 30 minutes");
  assert.equal(r.hit, true);
  assert.ok(r.resetAt);
  assert.ok(r.resetAt >= before + 1800 && r.resetAt <= before + 1800 + 5);
});

test("detectRateLimit: Retry-After header → relative", () => {
  const before = Math.floor(Date.now() / 1000);
  const r = detectRateLimit('rate_limit_error\nRetry-After: 600');
  assert.equal(r.hit, true);
  assert.ok(r.resetAt);
  assert.ok(r.resetAt >= before + 600 && r.resetAt <= before + 600 + 5);
});

test("detectRateLimit: HTTP 429 → limited", () => {
  const r = detectRateLimit('{"status":429,"error":"too many"}');
  assert.equal(r.hit, true);
});

test("detectRateLimit: 'quota exceeded' → limited", () => {
  const r = detectRateLimit("API quota exceeded for this hour");
  assert.equal(r.hit, true);
});

test("getContextTokens: missing file → 0", () => {
  assert.equal(getContextTokens("/no/such/file.jsonl"), 0);
});

test("getContextTokens: empty file → 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "continuum-"));
  const f = join(dir, "session.jsonl");
  writeFileSync(f, "");
  try {
    assert.equal(getContextTokens(f), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getContextTokens: file with usage → sums correctly", () => {
  const dir = mkdtempSync(join(tmpdir(), "continuum-"));
  const f = join(dir, "session.jsonl");
  const lines = [
    JSON.stringify({ type: "user", message: { content: "hi" } }),
    JSON.stringify({
      type: "assistant",
      message: {
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 5000,
          cache_read_input_tokens: 12000,
          output_tokens: 250,
        },
      },
    }),
    JSON.stringify({ type: "summary" }),
  ];
  writeFileSync(f, lines.join("\n"));
  try {
    assert.equal(getContextTokens(f), 17100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getContextTokens: walks back to find last usage entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "continuum-"));
  const f = join(dir, "session.jsonl");
  const lines = [
    JSON.stringify({
      type: "assistant",
      message: { usage: { input_tokens: 1, cache_read_input_tokens: 1 } },
    }),
    JSON.stringify({
      type: "assistant",
      message: { usage: { input_tokens: 999, cache_read_input_tokens: 1 } },
    }),
    JSON.stringify({ type: "user", message: { content: "next" } }),
    JSON.stringify({ type: "summary" }),
  ];
  writeFileSync(f, lines.join("\n"));
  try {
    assert.equal(getContextTokens(f), 1000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getContextTokens: tolerates malformed JSON lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "continuum-"));
  const f = join(dir, "session.jsonl");
  const lines = [
    "not valid json {{{",
    JSON.stringify({
      type: "assistant",
      message: { usage: { input_tokens: 5 } },
    }),
  ];
  writeFileSync(f, lines.join("\n"));
  try {
    assert.equal(getContextTokens(f), 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findSessionFile: finds existing session", () => {
  const dir = mkdtempSync(join(tmpdir(), "continuum-projects-"));
  const projDir = join(dir, "-tmp-myproject");
  mkdirSync(projDir, { recursive: true });
  const f = join(projDir, "abc-123.jsonl");
  writeFileSync(f, "");
  try {
    assert.equal(findSessionFile("abc-123", undefined, dir), f);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findSessionFile: missing session → throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "continuum-projects-"));
  try {
    assert.throws(() => findSessionFile("nope", undefined, dir), /not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findSessionFile: missing projects dir → throws", () => {
  assert.throws(
    () => findSessionFile("any", undefined, "/no/such/projects/root"),
    /No .* directory/,
  );
});
