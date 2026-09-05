import assert from "node:assert/strict";
import test from "node:test";

// portal.ts imports config, so env must be present before the module loads.
process.env.SCHOOL_URL = "https://school.example.com";
process.env.STATE_DIR = "/nonexistent-dir-for-test";

const { isNavigationInterrupted, isLoginFormVisible, openDailyLogFrame } = await import("../src/portal.js");

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

test("isNavigationInterrupted: matches detached-frame protocol error", () => {
  assert.equal(
    isNavigationInterrupted(
      new Error(
        'frame.goto: Protocol error (Page.navigate): No frame with given id found\nCall log:\n  - navigating to "https://x/daily_planner_parent.php", wait',
      ),
    ),
    true,
  );
  assert.equal(isNavigationInterrupted(new Error("frame.goto: Frame has been detached")), true);
});

test("isNavigationInterrupted: does not match unrelated errors", () => {
  assert.equal(isNavigationInterrupted(new Error("Timeout 30000ms exceeded")), false);
  assert.equal(isNavigationInterrupted(new Error("net::ERR_NAME_NOT_RESOLVED")), false);
  assert.equal(isNavigationInterrupted(undefined), false);
  assert.equal(isNavigationInterrupted(null), false);
});

test("isLoginFormVisible: detects the robot challenge text", async () => {
  const page = {
    getByText: () => ({ isVisible: async () => true }),
    locator: () => ({ isVisible: async () => false }),
  };
  assert.equal(await isLoginFormVisible(page as never), true);
});

test("isLoginFormVisible: detects the username field when the challenge text changed", async () => {
  const page = {
    getByText: () => ({ isVisible: async () => false }),
    locator: () => ({ isVisible: async () => true }),
  };
  assert.equal(await isLoginFormVisible(page as never), true);
});

test("isLoginFormVisible: false on the logged-in dashboard", async () => {
  const page = {
    getByText: () => ({ isVisible: async () => false }),
    locator: () => ({ isVisible: async () => false }),
  };
  assert.equal(await isLoginFormVisible(page as never), false);
});

// Minimal stubs for openDailyLogFrame: a child frame plus a page whose
// frameset contains it. Only the members the navigation touches are mocked.
function stubChildFrame(options: { dailydate: number; gotoImpl?: () => Promise<void> }) {
  const sidebarMatches = {
    first: () => ({ waitFor: async () => undefined, click: async () => undefined }),
    last: () => ({ click: async () => undefined }),
    count: async () => 0,
  };
  return {
    goto: options.gotoImpl ?? (async () => undefined),
    locator: (selector: string) => {
      if (selector === "#dailydate") return { count: async () => options.dailydate };
      return { locator: () => sidebarMatches, count: async () => 0 };
    },
  };
}

function stubPortalPage(child: ReturnType<typeof stubChildFrame>) {
  const main = {};
  return { frames: () => [main, child], mainFrame: () => main, waitForTimeout: async () => undefined, waitForLoadState: async () => undefined };
}

test("openDailyLogFrame: returns the planner frame when the date picker is present", async () => {
  const child = stubChildFrame({ dailydate: 1 });
  const frame = await openDailyLogFrame(stubPortalPage(child) as never);
  assert.equal(frame, child);
});

test("openDailyLogFrame: recovers from the detached-frame race when the planner settles", async () => {
  const child = stubChildFrame({
    dailydate: 1,
    gotoImpl: async () => {
      throw new Error('frame.goto: Protocol error (Page.navigate): No frame with given id found');
    },
  });
  const frame = await openDailyLogFrame(stubPortalPage(child) as never);
  assert.equal(frame, child);
});

test("openDailyLogFrame: throws instead of returning a frame that is not the planner", async () => {
  const child = stubChildFrame({ dailydate: 0 });
  await assert.rejects(() => openDailyLogFrame(stubPortalPage(child) as never), /Daily Log page did not load/);
});
