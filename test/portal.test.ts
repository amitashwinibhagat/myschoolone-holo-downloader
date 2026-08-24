import assert from "node:assert/strict";
import test from "node:test";

// portal.ts imports config, so env must be present before the module loads.
process.env.SCHOOL_URL = "https://school.example.com";
process.env.STATE_DIR = "/nonexistent-dir-for-test";

const { isNavigationInterrupted } = await import("../src/portal.js");

test("isNavigationInterrupted: matches Playwright's interrupted-navigation error", () => {
  assert.equal(
    isNavigationInterrupted(
      new Error(
        'frame.goto: Navigation to "https://x/daily_planner_parent.php" is interrupted by another navigation to "https://x/App.php"',
      ),
    ),
    true,
  );
});

test("isNavigationInterrupted: matches ERR_ABORTED", () => {
  assert.equal(isNavigationInterrupted(new Error("frame.goto: net::ERR_ABORTED at https://x")), true);
});

test("isNavigationInterrupted: does not match unrelated errors", () => {
  assert.equal(isNavigationInterrupted(new Error("Timeout 30000ms exceeded")), false);
  assert.equal(isNavigationInterrupted(new Error("net::ERR_NAME_NOT_RESOLVED")), false);
  assert.equal(isNavigationInterrupted(undefined), false);
  assert.equal(isNavigationInterrupted(null), false);
});
