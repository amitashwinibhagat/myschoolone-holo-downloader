import assert from "node:assert/strict";
import test from "node:test";

// browser.ts imports config, so env must be present before the module loads.
process.env.SCHOOL_URL = "https://school.example.com";
process.env.STATE_DIR = "/nonexistent-dir-for-test";

const { resolveActivePage } = await import("../src/browser.js");

function stubPage(closed: boolean) {
  return { isClosed: () => closed };
}

test("resolveActivePage: keeps the active page while it is open", () => {
  const active = stubPage(false);
  const other = stubPage(false);
  assert.equal(resolveActivePage([active, other] as never, active as never), active);
});

test("resolveActivePage: falls over to an open page after a popup closed", () => {
  const active = stubPage(true);
  const main = stubPage(false);
  assert.equal(resolveActivePage([active, main] as never, active as never), main);
});

test("resolveActivePage: returns the closed page when nothing is open", () => {
  const active = stubPage(true);
  assert.equal(resolveActivePage([active] as never, active as never), active);
});
