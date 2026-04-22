import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTime, formatDelay, formatTarget, shQuote } from "../dist/schedule.js";

test("parseTime: '+30s' → now + 30s", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const t = parseTime("+30s", now);
  assert.equal(t, now.getTime() + 30_000);
});

test("parseTime: 'in 5 minutes' → now + 300s", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const t = parseTime("in 5 minutes", now);
  assert.equal(t, now.getTime() + 300_000);
});

test("parseTime: 'in 2h' → now + 7200s", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const t = parseTime("in 2h", now);
  assert.equal(t, now.getTime() + 7_200_000);
});

test("parseTime: '4:10am' picks today if future", () => {
  const now = new Date("2026-01-01T01:00:00");
  const t = parseTime("4:10am", now);
  const d = new Date(t);
  assert.equal(d.getHours(), 4);
  assert.equal(d.getMinutes(), 10);
  assert.equal(d.getDate(), 1);
});

test("parseTime: '4:10am' picks tomorrow if past today", () => {
  const now = new Date("2026-01-01T08:00:00");
  const t = parseTime("4:10am", now);
  const d = new Date(t);
  assert.equal(d.getHours(), 4);
  assert.equal(d.getMinutes(), 10);
  assert.equal(d.getDate(), 2); // tomorrow
});

test("parseTime: '16:10' (24h) parses correctly", () => {
  const now = new Date("2026-01-01T08:00:00");
  const t = parseTime("16:10", now);
  const d = new Date(t);
  assert.equal(d.getHours(), 16);
  assert.equal(d.getMinutes(), 10);
});

test("parseTime: '12:00pm' = noon", () => {
  const now = new Date("2026-01-01T08:00:00");
  const t = parseTime("12:00pm", now);
  const d = new Date(t);
  assert.equal(d.getHours(), 12);
});

test("parseTime: '12:00am' = midnight", () => {
  const now = new Date("2026-01-01T20:00:00");
  const t = parseTime("12:00am", now);
  const d = new Date(t);
  assert.equal(d.getHours(), 0);
  // Past today (8pm > midnight today), so next midnight = tomorrow
  assert.equal(d.getDate(), 2);
});

test("parseTime: invalid input throws", () => {
  assert.throws(() => parseTime("nonsense"), /Cannot parse time/);
  assert.throws(() => parseTime("25:99"), /Invalid time/);
});

test("formatDelay: human-readable", () => {
  assert.equal(formatDelay(45), "45s");
  assert.equal(formatDelay(300), "5m");
  assert.equal(formatDelay(3600), "1h");
  assert.equal(formatDelay(3600 + 600), "1h 10m");
  assert.equal(formatDelay(7200), "2h");
});

test("formatTarget: includes day-of-week and time", () => {
  const out = formatTarget(new Date("2026-01-05T16:30:00").getTime());
  assert.match(out, /Mon/);
  assert.match(out, /4:30/);
});

test("shQuote: handles single quotes safely", () => {
  assert.equal(shQuote("hello"), "'hello'");
  assert.equal(shQuote("it's fine"), `'it'\\''s fine'`);
});
