import assert from "node:assert/strict";
import test from "node:test";

// portal.ts imports config, so env must be present before the module loads.
process.env.SCHOOL_URL = "https://school.example.com";
process.env.STATE_DIR = "/nonexistent-dir-for-test";

const { isNavigationInterrupted, isLoginFormVisible, openDailyLogFrame, signInControlLocator, describeSignInProbe, waitForLoginHandler } =
  await import("../src/portal.js");

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
  assert.equal(await isLoginFormVisible(page as never, 0), false);
});

test("isLoginFormVisible: polls until the form appears within the timeout", async () => {
  let checks = 0;
  const page = {
    getByText: () => ({ isVisible: async () => false }),
    locator: () => ({ isVisible: async () => ++checks >= 2 }),
  };
  assert.equal(await isLoginFormVisible(page as never, 1_000), true);
  assert.ok(checks >= 2, `expected at least 2 checks, got ${checks}`);
});

test("signInControlLocator: prefers clickable roles and excludes the Sign In heading", () => {
  const calls: string[] = [];
  const firstResult = { click: async () => undefined };
  const chain = {
    or: () => chain,
    first: () => firstResult,
  };
  const page = {
    getByRole: (role: string, options: { name: string; exact: boolean }) => {
      calls.push(`role:${role}:${options.name}:${options.exact}`);
      return chain;
    },
    getByText: (text: string, options: { exact: boolean }) => {
      calls.push(`text:${text}:${options.exact}`);
      return {
        filter: (opts: { hasNot: { __sel: string } }) => {
          calls.push(`filter:${opts.hasNot.__sel}`);
          return chain;
        },
      };
    },
    locator: (selector: string) => ({ __sel: selector }),
  };

  assert.equal(signInControlLocator(page as never), firstResult);
  assert.ok(calls.includes("role:button:Sign In:true"), calls.join(", "));
  assert.ok(calls.includes("role:link:Sign In:true"), calls.join(", "));
  // The text fallback must exclude the heading, or strict mode would trip again.
  assert.ok(calls.includes("filter:h1, h2, h3, h4, h5, h6"), calls.join(", "));
  // `.first()` must terminate the chain so a duplicated match cannot break click().
  assert.equal(firstResult.click instanceof Function, true);
});

test("describeSignInProbe: names rejected credentials", () => {
  const body = JSON.stringify(["Password", "", "", "", "", 1, 1]);
  assert.match(describeSignInProbe({ status: 200, body, consoleErrors: [] }), /rejected the credentials/);
});

test("describeSignInProbe: names a locked account", () => {
  const body = JSON.stringify([5, "", "", "", "", 5, 1]);
  assert.match(describeSignInProbe({ status: 200, body, consoleErrors: [] }), /account is locked/);
});

test("describeSignInProbe: flags accepted-but-no-redirect", () => {
  assert.match(describeSignInProbe({ status: 200, body: JSON.stringify([1]), consoleErrors: [] }), /did not redirect/);
});

test("describeSignInProbe: reports that the click never invoked login()", () => {
  assert.match(describeSignInProbe({ invoked: false, consoleErrors: [] }), /did not invoke the portal's login\(\)/);
});

test("describeSignInProbe: reports a failed logincheck.php request", () => {
  const probe = { requested: true, failure: "net::ERR_CONNECTION_RESET", consoleErrors: [] };
  assert.match(describeSignInProbe(probe), /request failed \(net::ERR_CONNECTION_RESET\)/);
});

test("describeSignInProbe: reports a request that was sent but never answered", () => {
  assert.match(describeSignInProbe({ requested: true, consoleErrors: [] }), /never answered/);
});

test("describeSignInProbe: reports that no logincheck.php request was issued", () => {
  assert.match(describeSignInProbe({ consoleErrors: [] }), /never issued a logincheck\.php request/);
});

test("describeSignInProbe: surfaces an error thrown from inside login()", () => {
  const probe = { requested: true, scriptError: "TypeError: x\n  at login (app.js:1)", consoleErrors: [] };
  assert.match(describeSignInProbe(probe), /login\(\) threw: TypeError: x/);
});

test("describeSignInProbe: surfaces a page script error first", () => {
  const probe = { consoleErrors: ["ReferenceError: login is not defined"] };
  assert.match(describeSignInProbe(probe), /ReferenceError/);
});

test("describeSignInProbe: tolerates a non-JSON body (e.g. a challenge page)", () => {
  assert.match(
    describeSignInProbe({ status: 403, body: "<html>Just a moment</html>", consoleErrors: [] }),
    /unreadable logincheck/,
  );
});

test("waitForLoginHandler: true once the inline handler exists", async () => {
  let calls = 0;
  const page = { evaluate: async () => ++calls >= 2 };
  assert.equal(await waitForLoginHandler(page as never, 1_000), true);
  assert.ok(calls >= 2, `expected at least 2 probes, got ${calls}`);
});

test("waitForLoginHandler: false when the handler never appears, without throwing", async () => {
  const page = { evaluate: async () => false };
  assert.equal(await waitForLoginHandler(page as never, 0), false);
});

// Minimal stubs for openDailyLogFrame: a child frame plus a page whose
// frameset contains it. Only the members the navigation touches are mocked.
function stubChildFrame(options: { dailydate: number; gotoImpl?: () => Promise<void> }) {
  const sidebarMatches = {
    first: () => ({ waitFor: async () => undefined, click: async () => undefined }),
    last: () => ({ click: async () => undefined }),
    count: async () => 0,
  };
  const permissiveLocator = {
    isVisible: async () => false,
    locator: () => sidebarMatches,
    first: () => ({ waitFor: async () => undefined, click: async () => undefined }),
    count: async () => 0,
  };
  return {
    goto: options.gotoImpl ?? (async () => undefined),
    url: () => "https://portal.example/Web/LearningManagement/daily_planner_parent.php",
    // Mimic Playwright: resolve when the picker is present, otherwise behave
    // like a timeout (reject), which the caller catches and falls back on.
    waitForSelector: async (selector: string) => {
      if (selector === "#dailydate" && options.dailydate > 0) return {};
      throw new Error(`Timeout waiting for selector "${selector}"`);
    },
    locator: (selector: string) => {
      if (selector === "#dailydate") return { count: async () => options.dailydate };
      return permissiveLocator;
    },
  };
}

function stubPortalPage(child: ReturnType<typeof stubChildFrame>) {
  const main = { url: () => "https://portal.example/Web/App.php" };
  return {
    frames: () => [main, child],
    mainFrame: () => main,
    waitForTimeout: async () => undefined,
    waitForLoadState: async () => undefined,
    url: () => "https://portal.example/Web/App.php",
    getByText: () => ({ isVisible: async () => false }),
    locator: () => ({ isVisible: async () => false }),
  };
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
