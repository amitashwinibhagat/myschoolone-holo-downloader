import assert from "node:assert/strict";
import test from "node:test";

// session-restore.ts imports config (via http-client), so env must exist first.
process.env.SCHOOL_URL = "https://school.example.com";

const { selectInjectableCookies, EXPIRY_MARGIN_MS } = await import("../src/session-restore.js");

const NOW = Date.parse("2026-10-29T12:00:00Z");
const future = Math.floor((NOW + 6 * 3600_000) / 1000);
const soon = Math.floor((NOW + 60_000) / 1000);

function cookie(over: Record<string, unknown> = {}) {
  return { name: "PHPSESSID", value: "abc", domain: "school.example.com", path: "/", expires: future, ...over };
}

test("selectInjectableCookies: keeps a live session cookie", () => {
  const out = selectInjectableCookies([cookie()], NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "PHPSESSID");
  assert.equal(out[0].domain, "school.example.com");
  assert.equal(out[0].path, "/");
});

test("selectInjectableCookies: drops session cookies (expires <= 0)", () => {
  // These come from the persistent profile, not a portable snapshot.
  assert.deepEqual(selectInjectableCookies([cookie({ expires: -1 })], NOW), []);
  assert.deepEqual(selectInjectableCookies([cookie({ expires: 0 })], NOW), []);
  assert.deepEqual(selectInjectableCookies([cookie({ expires: undefined })], NOW), []);
});

test("selectInjectableCookies: drops cookies that expire mid-run", () => {
  assert.deepEqual(selectInjectableCookies([cookie({ expires: soon })], NOW), []);
});

test("selectInjectableCookies: keeps a cookie that expires just past the margin", () => {
  const justPast = Math.floor((NOW + EXPIRY_MARGIN_MS + 60_000) / 1000);
  assert.equal(selectInjectableCookies([cookie({ expires: justPast })], NOW).length, 1);
});

test("selectInjectableCookies: drops malformed entries", () => {
  assert.deepEqual(selectInjectableCookies([cookie({ name: "" })], NOW), []);
  assert.deepEqual(selectInjectableCookies([cookie({ value: "" })], NOW), []);
  assert.deepEqual(selectInjectableCookies([cookie({ domain: "" })], NOW), []);
});

test("selectInjectableCookies: dedupes the same name+domain+path", () => {
  const out = selectInjectableCookies([cookie(), cookie({ value: "dup" })], NOW);
  assert.equal(out.length, 1);
});

test("selectInjectableCookies: preserves security flags and defaults the path", () => {
  const out = selectInjectableCookies(
    [cookie({ httpOnly: true, secure: true, sameSite: "Lax", path: undefined })],
    NOW,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].httpOnly, true);
  assert.equal(out[0].secure, true);
  assert.equal(out[0].sameSite, "Lax");
  assert.equal(out[0].path, "/");
});

test("selectInjectableCookies: mixed list keeps only the usable ones", () => {
  const out = selectInjectableCookies(
    [cookie({ name: "a" }), cookie({ name: "b", expires: -1 }), cookie({ name: "c", expires: soon })],
    NOW,
  );
  assert.deepEqual(out.map((c) => c.name), ["a"]);
});

test("selectInjectableCookies: empty input is safe", () => {
  assert.deepEqual(selectInjectableCookies([], NOW), []);
});
