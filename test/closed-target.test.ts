import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import type { BrowserSession } from "../src/browser.js";

// run-download.ts imports config, so env must be present before the module loads.
process.env.SCHOOL_URL = "https://school.example.com";
process.env.STATE_DIR = "/nonexistent-dir-for-test";

const { isClosedTargetError, withLivePage } = await import("../src/run-download.js");

function fakeSession(pages: Page[]): BrowserSession {
  let next = 0;
  return {
    context: {} as BrowserSession["context"],
    getPage: () => pages[Math.min(next++, pages.length - 1)],
  };
}

function fakePage(overrides: Partial<Page> = {}): Page {
  return { isClosed: () => false, ...overrides } as unknown as Page;
}

test("isClosedTargetError: matches every shape a dead target can surface as", () => {
  assert.equal(isClosedTargetError(new Error("Target page, context or browser has been closed")), true);
  assert.equal(isClosedTargetError(new Error("Target closed")), true);
  assert.equal(isClosedTargetError(new Error("Browser has been closed")), true);
  assert.equal(isClosedTargetError(new Error("Session closed")), true);
  // Multi-line Playwright call-log form (the shape seen on the first cloud run).
  assert.equal(
    isClosedTargetError(new Error('frame.goto: Target page, context or browser has been closed\n\nCall log:\n  - navigating to "https://example.com"')),
    true,
  );
});

test("isClosedTargetError: does not match unrelated navigation or generic errors", () => {
  assert.equal(isClosedTargetError(new Error("page.goto: interrupted by another navigation")), false);
  assert.equal(isClosedTargetError(new Error("net::ERR_CONNECTION_REFUSED")), false);
  assert.equal(isClosedTargetError(new Error("Daily Log page did not load")), false);
});

test("withLivePage: retries once on a closed target and succeeds on the re-resolved page", async () => {
  const first = fakePage();
  const second = fakePage();
  const session = fakeSession([first, second]);
  const ops: Page[] = [];

  const result = await withLivePage(session, async (page) => {
    ops.push(page);
    if (ops.length === 1) throw new Error("frame.goto: Target page, context or browser has been closed");
    return `used:${page === second ? "second" : "first"}`;
  });

  assert.deepEqual(ops, [first, second]);
  assert.equal(result, "used:second");
});

test("withLivePage: propagates non-closed errors immediately without a retry", async () => {
  const only = fakePage();
  const session = fakeSession([only]);
  let calls = 0;

  await assert.rejects(
    withLivePage(session, async () => {
      calls += 1;
      throw new Error("net::ERR_CONNECTION_REFUSED");
    }),
    /ERR_CONNECTION_REFUSED/,
  );
  assert.equal(calls, 1);
});

test("withLivePage: when the whole context died, the retried op fails with its own clear error", async () => {
  const dead = fakePage();
  const session = fakeSession([dead, dead]); // getPage keeps returning the same dead handle
  let calls = 0;

  await assert.rejects(
    withLivePage(session, async () => {
      calls += 1;
      throw new Error("Target page, context or browser has been closed");
    }),
    /has been closed/,
  );
  assert.equal(calls, 2);
});
