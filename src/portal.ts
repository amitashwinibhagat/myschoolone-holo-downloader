import fs from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright";
import { waitForHumanCheck } from "./browser.js";
import { config } from "./config.js";
import { isClosedTargetError, redactPasswordValues, sleep, withTimeout } from "./utils.js";

/**
 * Raised when the portal shows a login form but the browser cannot complete
 * the sign-in automatically (no autofilled credentials). Retrying won't help;
 * a human must run `npm run login`.
 */
export class NeedsHumanLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeedsHumanLoginError";
  }
}

/** The portal renders its app inside a sub-frame; pick the non-main frame. */
export function appFrame(page: Page): Frame {
  return page.frames().find((frame) => frame !== page.mainFrame()) || page.mainFrame();
}

/** Portal path of the Daily Log (daily planner) page. */
export const DAILY_LOG_PATH = "/Web/LearningManagement/daily_planner_parent.php";

/**
 * True when a frame/page navigation was aborted by a competing navigation.
 *
 * Also matches the detached-frame race: the portal's `App.php` frameset
 * wrapper can rebuild its sub-frames while `frame.goto()` is in flight,
 * which Playwright surfaces as `Protocol error (Page.navigate): No frame
 * with given id found` instead of the usual interrupted-navigation error.
 * Both mean the same thing (the wrapper hijacked the navigation), so both
 * follow the same settle-and-use-the-sidebar recovery path.
 */
export function isNavigationInterrupted(error: unknown): boolean {
  const message = (error as Error)?.message || "";
  // A closed target during post-login navigation is the same wrapper race in
  // another costume: on a cold session (fresh cloud profile) the programmatic
  // sign-in lands mid-redirect, and the transitional frame our goto targeted
  // is torn down by App.php's rebuild — Playwright reports the target as
  // closed instead of an interrupted navigation.
  if (isClosedTargetError(error)) return true;
  return /interrupted by another navigation|ERR_ABORTED|No frame with given id found|Frame has been detached/.test(
    message,
  );
}

/**
 * Navigate to the Daily Log page and return the frame that contains it.
 *
 * The portal serves the planner inside an `App.php` frameset wrapper. A direct
 * `frame.goto()` to the planner URL is frequently hijacked by a top-level
 * redirect back to `App.php`, which Playwright surfaces as an interrupted
 * navigation (`ERR_ABORTED`) or a detached-frame protocol error (`No frame
 * with given id found`) when the wrapper rebuilds its sub-frames mid-flight.
 * When that happens we let the wrapper settle and
 * fall back to clicking the "Daily Log" entry in the sidebar — the stable
 * in-app route. Shared by the daily run and the backfill so the behaviour
 * cannot drift between them.
 */
/**
 * Find the sub-frame currently hosting the planner date picker / the sidebar
 * menu. Both are re-scanned on every call because App.php rebuilds its
 * sub-frames whenever it navigates (invalidating held handles), and neither
 * widget is guaranteed to live in the first sub-frame.
 */
async function findPickerFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    if ((await frame.locator("#dailydate").count().catch(() => 0)) > 0) return frame;
  }
  return undefined;
}

async function findSidebarFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    if ((await frame.locator("text=/daily\\s*log/i").count().catch(() => 0)) > 0) return frame;
  }
  return undefined;
}

export async function openDailyLogFrame(page: Page): Promise<Frame> {
  const url = new URL(DAILY_LOG_PATH, config.schoolUrl).toString();

  try {
    await appFrame(page).goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch (error) {
    if (!isNavigationInterrupted(error)) throw error;
    console.warn("Frame navigation interrupted by the App.php wrapper — waiting for it to settle...");
    await page.waitForTimeout(2_000);
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
  }

  // Wait for the planner to render, re-scanning all sub-frames every round:
  // the App.php wrapper rebuilds its frames while we wait (handles go stale)
  // and the picker may live in any sub-frame. The date picker is the positive
  // readiness signal.
  for (let waited = 0; waited < 16_000; waited += 2_000) {
    const picker = await findPickerFrame(page);
    if (picker) return picker;
    await page.waitForTimeout(2_000);
  }

  // Not on the planner yet — route through the sidebar inside the wrapper.
  // Bounded by rounds, not wall-clock: each round re-scans the live frames,
  // so total wait scales with what the wrapper is actually doing (~2s per
  // empty round, longer only when a real click is in progress).
  for (let round = 0; round < 12; round += 1) {
    // A cold session can bounce back to the login form after the wrapper
    // reload (rejected cookie / expired redirect). Re-signing in once
    // recovers without burning the whole attempt.
    if (await isLoginFormVisibleNow(page)) {
      console.log("Session bounced back to the login form — signing in again...");
      await ensureLoggedIn(page);
      continue;
    }

    const frame = await findSidebarFrame(page);
    if (!frame) {
      await page.waitForTimeout(2_000);
      continue;
    }
    const link = frame.locator("text=/daily\\s*log/i").locator("visible=true");
    const appeared = await link
      .first()
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!appeared) continue;
    await link.first().click().catch(() => undefined);
    await page.waitForTimeout(2_000);

    // The sidebar expands into a parent item plus a submenu. When more than
    // one "Daily Log" entry is visible, click the deepest (submenu) one.
    const matches = (await findSidebarFrame(page))?.locator("text=/daily\\s*log/i").locator("visible=true");
    if (matches && (await matches.count().catch(() => 0)) > 1) {
      await matches.last().click().catch(() => undefined);
      await page.waitForTimeout(6_000);
    }
    const finalFrame = await findPickerFrame(page);
    if (finalFrame) return finalFrame;
    // Picker not up yet — pace the retry so we never click-spam the menu
    // while the wrapper is still rebuilding.
    await sleep(2_000);
  }

  // Blind-spot insurance: describe the portal state before failing (URL
  // paths only — never page content, run logs are public). This turns the
  // next failure into an aimed fix instead of a guess.
  const frameUrls = page.frames().map((frame) => frame.url());
  console.error(
    `Portal state at failure — top: ${page.url()}; frames: ${
      frameUrls.filter(Boolean).join(" | ") || "(none)"
    }`,
  );
  // Never hand back a frame that is not the planner: downstream code would
  // silently harvest the wrong view into a mislabeled date folder. Fail
  // loudly so the run retries, captures failure debug, and notifies.
  throw new Error(
    "Daily Log page did not load (no date picker found after navigation). " +
      "The portal layout may have changed — run `npm run health` and `npm run capture`.",
  );
}

/**
 * True when the portal is showing its login form: either the "I'm not a
 * robot" challenge text or the username field is visible. Checking both
 * keeps auto-login working when the portal rewords its challenge but keeps
 * the same form fields (and vice versa).
 */
/**
 * Immediate, non-waiting check for the login form: the "I'm not a robot"
 * challenge text or the username field. Both are checked so auto-login keeps
 * working when the portal rewords its challenge but keeps the form fields.
 */
export async function isLoginFormVisibleNow(page: Page): Promise<boolean> {
  const robot = await page.getByText("I'm not a robot").isVisible().catch(() => false);
  if (robot) return true;
  return page.locator("#user_names").isVisible().catch(() => false);
}

/**
 * Poll for the login form, returning true as soon as it appears and false once
 * `timeoutMs` elapses. `locator.isVisible()` does not auto-wait, so this is a
 * bounded poll rather than two stacked waits.
 */
export async function isLoginFormVisible(page: Page, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isLoginFormVisibleNow(page)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(200);
  }
}

/**
 * Wait for any Cloudflare challenge to clear and, if a login form is showing,
 * sign in automatically. Credentials come from SCHOOL_USERNAME/SCHOOL_PASSWORD
 * in .env when set (fully deterministic); otherwise the browser's autofilled
 * values are used (polled for up to ~15s). One transient failure is retried
 * after a page reload; never more than two attempts to avoid tripping the
 * portal's login-attempt lockout.
 */
export async function ensureLoggedIn(page: Page): Promise<void> {
  await waitForHumanCheck(page);
  // Bound the network-idle wait: the portal keeps long-lived connections open,
  // so it often never fires and would otherwise burn the full timeout on every
  // run. A short settle plus the login-form poll below is enough.
  await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => undefined);
  await page.waitForTimeout(1_500);

  if (!(await isLoginFormVisible(page))) return;

  // Resolve credentials: env vars first, otherwise Chrome autofill.
  let username = config.schoolUsername;
  let password = config.schoolPassword;
  if (!username || !password) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      username = username || (await page.locator("#user_names").inputValue().catch(() => ""));
      password = password || (await page.locator("#password").inputValue().catch(() => ""));
      if (username && password) break;
      await page.waitForTimeout(1_000);
    }
  }
  if (!username || !password) {
    throw new NeedsHumanLoginError(
      "Login form is showing but no credentials are available. Set " +
        "SCHOOL_USERNAME and SCHOOL_PASSWORD in .env for automatic re-login, " +
        "or run `npm run login` once.",
    );
  }

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await performSignIn(page, username, password);
      return;
    } catch (error) {
      if (attempt === 2) throw error;
      console.warn(`Auto sign-in attempt ${attempt} failed (${(error as Error).message}) — reloading and retrying once.`);
      await page.goto(config.schoolUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
      await waitForHumanCheck(page);
      await page.waitForTimeout(3_000);
      if (!(await isLoginFormVisible(page))) return;
    }
  }
}

/** Fill the login form deterministically and submit. Throws on failure. */
async function performSignIn(page: Page, username: string, password: string): Promise<void> {
  // Set the values via evaluate so Chrome's autofill/overlays cannot race or
  // clear them before login() reads the fields.
  await withTimeout(
    page.evaluate(
      ({ u, p }) => {
        const user = document.querySelector("#user_names") as HTMLInputElement | null;
        const pass = document.querySelector("#password") as HTMLInputElement | null;
        if (!user || !pass) throw new Error("login fields not found");
        user.value = u;
        pass.value = p;
        user.dispatchEvent(new Event("input", { bubbles: true }));
        pass.dispatchEvent(new Event("input", { bubbles: true }));
      },
      { u: username, p: password },
    ),
    15_000,
    "Filling the login form",
  );

  const actualUser = await page.locator("#user_names").inputValue().catch(() => "");
  const actualPass = await page.locator("#password").inputValue().catch(() => "");
  if (!actualUser || !actualPass) {
    throw new NeedsHumanLoginError("Failed to set login credentials on the form.");
  }

  // Tick the "I'm not a robot" checkbox deterministically and verify.
  await withTimeout(
    page.evaluate(() => {
      const box = document.querySelector("#imrobot") as HTMLInputElement | null;
      if (!box) throw new Error("robot checkbox not found");
      box.checked = true;
      box.dispatchEvent(new Event("change", { bubbles: true }));
    }),
    15_000,
    "Ticking the robot checkbox",
  );
  const checked = await page.locator("#imrobot").isChecked().catch(() => false);
  if (!checked) await page.locator("#imrobot").check({ force: true }).catch(() => undefined);

  console.log("Login form detected — signing in automatically...");
  await page.getByText("Sign In", { exact: true }).click();

  // login() RSA-encrypts the values and submits via AJAX; wait for the form to
  // actually go away.
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2_000);
    if (!(await isLoginFormVisible(page, 1_000))) return;
  }

  throw new NeedsHumanLoginError(
    "Automatic sign-in failed; the login form is still visible. " +
      "Check SCHOOL_USERNAME/SCHOOL_PASSWORD in .env, or run `npm run login` manually.",
  );
}

/** Write a screenshot + page HTML snapshot for failure diagnostics. */
export async function writeFailureDebug(page: Page, label: string): Promise<void> {
  const dir = path.join(config.debugDir, new Date().toISOString().replace(/[:.]/g, "-"));
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => undefined);
  await page.screenshot({ path: path.join(dir, `${label}.png`) }).catch(() => undefined);
  await fs.writeFile(path.join(dir, "page.html"), await sanitizedPageHtml(page), { mode: 0o600 });
}

/**
 * Serialized page HTML with any filled password values cleared from the DOM
 * and redacted from the markup, so debug snapshots never contain credentials.
 */
export async function sanitizedPageHtml(page: Page): Promise<string> {
  await page
    .evaluate(() => {
      for (const el of document.querySelectorAll<HTMLInputElement>('input[type="password"]')) {
        el.value = "";
        el.removeAttribute("value");
      }
    })
    .catch(() => undefined);
  return redactPasswordValues(await page.content().catch(() => ""));
}
