import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSelection, filterByIds, filterByNames } from "../dist/picker.js";

const fakeSession = (id, name) => ({
  sessionId: id,
  filepath: "",
  size: 0,
  mtime: new Date(),
  cwd: undefined,
  name,
  firstPrompt: undefined,
  lastEntryType: undefined,
  cleanlyEnded: false,
});

test("parseSelection: empty → []", () => {
  assert.deepEqual(parseSelection("", 5), []);
});

test("parseSelection: 'none' → []", () => {
  assert.deepEqual(parseSelection("none", 5), []);
});

test("parseSelection: 'all' → [1..N]", () => {
  assert.deepEqual(parseSelection("all", 4), [1, 2, 3, 4]);
});

test("parseSelection: '1,3,5'", () => {
  assert.deepEqual(parseSelection("1,3,5", 5), [1, 3, 5]);
});

test("parseSelection: '1-3'", () => {
  assert.deepEqual(parseSelection("1-3", 5), [1, 2, 3]);
});

test("parseSelection: '1-3,5,7-8' mixed", () => {
  assert.deepEqual(parseSelection("1-3,5,7-8", 10), [1, 2, 3, 5, 7, 8]);
});

test("parseSelection: dedupes overlapping", () => {
  assert.deepEqual(parseSelection("1-3,2,3", 5), [1, 2, 3]);
});

test("parseSelection: tolerates whitespace", () => {
  assert.deepEqual(parseSelection("1, 3 , 5", 5), [1, 3, 5]);
});

test("parseSelection: out-of-range throws", () => {
  assert.throws(() => parseSelection("99", 5), /out of bounds/);
  assert.throws(() => parseSelection("1-99", 5), /out of bounds/);
});

test("parseSelection: bad token throws", () => {
  assert.throws(() => parseSelection("abc", 5), /Bad selection/);
});

test("parseSelection: inverted range throws", () => {
  assert.throws(() => parseSelection("5-1", 5), /out of bounds/);
});

test("filterByIds: empty filter → all sessions pass", () => {
  const sessions = [fakeSession("abc", "A"), fakeSession("def", "B")];
  assert.equal(filterByIds(sessions, []).length, 2);
});

test("filterByIds: prefix match", () => {
  const sessions = [fakeSession("abc-123", "A"), fakeSession("def-456", "B"), fakeSession("abc-789", "C")];
  const out = filterByIds(sessions, ["abc"]);
  assert.equal(out.length, 2);
  assert.equal(out[0].sessionId, "abc-123");
  assert.equal(out[1].sessionId, "abc-789");
});

test("filterByIds: multiple prefixes (OR)", () => {
  const sessions = [fakeSession("abc-1", "A"), fakeSession("def-1", "B"), fakeSession("xyz-1", "C")];
  const out = filterByIds(sessions, ["abc", "def"]);
  assert.equal(out.length, 2);
});

test("filterByNames: case-insensitive substring", () => {
  const sessions = [
    fakeSession("a", "Anterior Implant"),
    fakeSession("b", "Multi Tenant 2"),
    fakeSession("c", "Cinema"),
  ];
  const out = filterByNames(sessions, ["tenant"]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "Multi Tenant 2");
});

test("filterByNames: multiple patterns (OR)", () => {
  const sessions = [
    fakeSession("a", "Anterior Implant"),
    fakeSession("b", "Multi Tenant 2"),
    fakeSession("c", "Cinema"),
  ];
  const out = filterByNames(sessions, ["anterior", "cinema"]);
  assert.equal(out.length, 2);
});

test("filterByNames: matches first-prompt fallback when no name", () => {
  const sessions = [
    { ...fakeSession("a", undefined), firstPrompt: "Help me with the orc daemon" },
    { ...fakeSession("b", undefined), firstPrompt: "Random other thing" },
  ];
  const out = filterByNames(sessions, ["orc"]);
  assert.equal(out.length, 1);
  assert.equal(out[0].sessionId, "a");
});
