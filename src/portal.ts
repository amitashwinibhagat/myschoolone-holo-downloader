import fs from "node:fs/promises";
import path from "node:path";
import type { ConsoleMessage, Frame, Locator, Page, Request, Response } from "playwright";
import { detectChallengeText, waitForHumanCheck } from "./browser.js";
import { config } from "./config.js";
import { createHash } from "node:crypto";
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

/**
 * Poll for the picker frame on a short interval, returning as soon as it
 * exists. The date picker is the positive readiness signal, so this replaces a
 * blind 2s-per-round sleep: a fast render now costs ~250ms instead of a full
 * round, while the overall budget and the frame re-scan are unchanged.
 *
 * Bounded by rounds rather than wall-clock (matching the sidebar loop): a wait
 * that returns instantly can then never spin for the full budget.
 */
async function waitForPickerFrame(page: Page, timeoutMs: number, pollMs = 250): Promise<Frame | undefined> {
  const rounds = Math.max(1, Math.ceil(timeoutMs / pollMs));
  for (let round = 0; round < rounds; round += 1) {
    const picker = await findPickerFrame(page);
    if (picker) return picker;
    await page.waitForTimeout(pollMs);
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

/**
 * True once the App.php shell has mounted at least one sub-frame. Deep-link
 * navigations bounce to the tenant root until the shell bootstraps, so this
 * is the gate that tells "ready to navigate inside the app" from "still on a
 * stub page".
 */
async function waitForAppShell(page: Page, timeoutMs = 12_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.frames().length > 1) return true;
    await page.waitForTimeout(1_000);
  }
  return false;
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

    // The interrupted goto usually still leaves the wrapper loading its own
    // sub-frames — but not always the planner, and on a cold session the
    // bounce can leave the browser on the tenant root with NO frames at all.
    // In that state nothing can be clicked or waited for: enter through the
    // front door once so the shell can bootstrap, then re-drive the planner.
    if (await detectChallengeText(page)) await waitForHumanCheck(page);
    if (!(await waitForAppShell(page))) {
      console.log("App shell did not mount — entering through the portal front door once...");
      await page.goto(config.schoolUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
      await page.waitForTimeout(3_000);
      if (await detectChallengeText(page)) await waitForHumanCheck(page);
      if (!(await isLoginFormVisibleNow(page))) await waitForAppShell(page, 15_000);
    }
    console.log("Re-driving the planner navigation once after the wrapper settled...");
    try {
      await appFrame(page).goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch (retryError) {
      if (!isNavigationInterrupted(retryError)) throw retryError;
      console.warn("Re-drive interrupted as well — letting the wrapper settle and continuing...");
      await page.waitForTimeout(2_000);
      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
    }
  }

  // Wait for the planner to render, re-scanning all sub-frames every round:
  // the App.php wrapper rebuilds its frames while we wait (handles go stale)
  // and the picker may live in any sub-frame. The date picker is the positive
  // readiness signal, so poll for it rather than sleeping a fixed 2s per round.
  const initialPicker = await waitForPickerFrame(page, 16_000);
  if (initialPicker) return initialPicker;

  // Not on the planner yet — route through the sidebar inside the wrapper.
  // Bounded by rounds, not wall-clock: each round re-scans the live frames,
  // so total wait scales with what the wrapper is actually doing (~2s per
  // empty round, longer only when a real click is in progress).
  for (let round = 0; round < 12; round += 1) {
    // A challenge interstitial can appear mid-flow (front-door entry, frame
    // navigations); wait it out before looking for anything else.
    if (await detectChallengeText(page)) {
      await waitForHumanCheck(page);
      continue;
    }
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

    // The sidebar expands into a parent item plus a submenu. When more than
    // one "Daily Log" entry is visible, click the deepest (submenu) one.
    const matches = (await findSidebarFrame(page))?.locator("text=/daily\\s*log/i").locator("visible=true");
    if (matches && (await matches.count().catch(() => 0)) > 1) {
      await matches.last().click().catch(() => undefined);
    }

    // Wait for the picker itself (positive signal) instead of a flat 2s + 6s
    // after each click; the outer rounds still bound the total attempt.
    const clickedPicker = await waitForPickerFrame(page, 8_000);
    if (clickedPicker) return clickedPicker;
    // Picker not up yet — pace the retry so we never click-spam the menu
    // while the wrapper is still rebuilding.
    await sleep(2_000);
  }

  // Blind-spot insurance: describe the portal state before failing (URL
  // paths only — never page content, run logs are public). This turns the
  // next failure into an aimed fix instead of a guess.
  // Paths + a short URL hash only (never full URLs — they contain the
  // SCHOOL_URL secret, which GitHub masks into uselessness — and never page
  // content, run logs are public). Enough to tell login page vs. app shell
  // vs. planner without leaking anything.
  const describe = (u: string): string => {
    if (!u) return "";
    const path = u.replace(/^https?:\/\/[^/]+/i, "");
    const hash = createHash("sha256").update(u).digest("hex").slice(0, 8);
    return `${path}#${hash}`;
  };
  const frameDescs = page.frames().map((frame) => describe(frame.url()));
  console.error(
    `Portal state at failure — top: ${describe(page.url())}; frames: ${
      frameDescs.filter(Boolean).join(" | ") || "(none)"
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
      // The portal redirects through the app shell after sign-in; let that
      // chain land before any deep-link navigation — a goto racing it gets
      // bounced to the tenant root.
      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
      await page.waitForTimeout(2_000);
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

/**
 * Locator for the login form's "Sign In" control.
 *
 * The portal renders an `<h3>Sign In</h3>` heading next to the real control,
 * so a bare `getByText("Sign In", { exact: true })` resolves to two nodes and
 * trips Playwright's strict mode. Prefer the accessible button/link roles, and
 * only fall back to exact text that is not a heading.
 */
export function signInControlLocator(page: Page): Locator {
  return page
    .getByRole("button", { name: "Sign In", exact: true })
    .or(page.getByRole("link", { name: "Sign In", exact: true }))
    .or(
      page
        .getByText("Sign In", { exact: true })
        .filter({ hasNot: page.locator("h1, h2, h3, h4, h5, h6") }),
    )
    .first();
}

/** What we managed to observe from the portal's `logincheck.php` AJAX POST. */
export interface SignInProbe {
  status?: number;
  body?: string;
  /** True once a logincheck.php request was issued. */
  requested?: boolean;
  /** Playwright's network-failure reason, when the request failed. */
  failure?: string;
  /** Whether the click actually invoked the portal's login() handler. */
  invoked?: boolean;
  /** Error thrown from inside login(), if any. */
  scriptError?: string;
  consoleErrors: string[];
}

/**
 * Wait for the portal's inline `login()` submit handler to exist.
 *
 * The Sign In control is `<a onclick="login()">` and `login()` is defined in an
 * inline script that only runs after jQuery/JSEncrypt load. Clicking before then
 * makes the inline handler throw a ReferenceError and silently does nothing — the
 * form simply stays put. Bounded and non-fatal: if the handler never shows up we
 * still click, so a future layout that submits another way is not blocked.
 */
export async function waitForLoginHandler(page: Page, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ready = await withTimeout(
      page.evaluate(() => typeof (window as unknown as { login?: unknown }).login === "function"),
      5_000,
      "Checking for the login() handler",
    ).catch(() => false);
    if (ready) return true;
    if (Date.now() >= deadline) return false;
    await sleep(250);
  }
}

/**
 * Turn the captured `logincheck.php` exchange into a one-line reason.
 *
 * `login()` has no AJAX error handler, so a rejected or unparseable response
 * leaves the form untouched with no lasting visible clue (its toastr hides after
 * 2s). The response's first field is the portal's verdict: `"Username"`/`"Password"`
 * = bad credentials, `5` = locked, `1` = accepted but the redirect never landed.
 */
export function describeSignInProbe(probe: SignInProbe): string {
  if (probe.consoleErrors.length > 0) return `page script error: ${probe.consoleErrors[0]}`;
  if (probe.invoked === false) return "the Sign In click did not invoke the portal's login() handler";
  if (probe.scriptError) return `login() threw: ${probe.scriptError.split("\n")[0]}`;
  if (probe.status === undefined) {
    if (probe.failure) return `the logincheck.php request failed (${probe.failure})`;
    if (probe.requested) return "logincheck.php was requested but never answered";
    return "login() never issued a logincheck.php request";
  }
  if (probe.body) {
    let verdict: unknown;
    try {
      verdict = (JSON.parse(probe.body) as unknown[])[0];
    } catch {
      /* not JSON — fall through to the raw-body reason */
    }
    if (verdict === "Username" || verdict === "Password") {
      return `the portal rejected the credentials (HTTP ${probe.status}, verdict ${verdict})`;
    }
    if (verdict === 5) return `the account is locked (HTTP ${probe.status})`;
    if (verdict === 1) return `credentials accepted but the portal did not redirect (HTTP ${probe.status})`;
    if (verdict !== undefined) return `unexpected portal verdict ${JSON.stringify(verdict)} (HTTP ${probe.status})`;
    return `unreadable logincheck.php response (HTTP ${probe.status}): ${probe.body.slice(0, 120)}`;
  }
  return `logincheck.php returned HTTP ${probe.status} with an unreadable body`;
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

  // The inline login() handler must exist or the click is a silent no-op.
  if (!(await waitForLoginHandler(page))) {
    console.warn("Portal login() handler not detected — clicking the Sign In control anyway.");
  }

  // Wrap login() so we can distinguish "the click never invoked it" from "it ran
  // but the POST failed", and watch the request lifecycle on the Playwright side.
  await page
    .evaluate(() => {
      const w = window as unknown as {
        login?: (...args: unknown[]) => unknown;
        __msoLogin?: { invoked: number; error: string | null };
      };
      w.__msoLogin = { invoked: 0, error: null };
      const original = w.login;
      if (typeof original !== "function") return;
      w.login = function (this: unknown, ...args: unknown[]) {
        w.__msoLogin!.invoked += 1;
        try {
          return original.apply(this, args);
        } catch (error) {
          w.__msoLogin!.error = String((error as Error)?.stack || error);
          throw error;
        }
      };
    })
    .catch(() => undefined);

  // Capture what the submit actually did, so a failure is self-explaining.
  const probe: SignInProbe = { consoleErrors: [] };
  const onRequest = (request: Request): void => {
    if (/logincheck\.php/i.test(request.url())) probe.requested = true;
  };
  const onRequestFailed = (request: Request): void => {
    if (/logincheck\.php/i.test(request.url())) probe.failure = request.failure()?.errorText || "unknown failure";
  };
  const onResponse = (response: Response): void => {
    if (!/logincheck\.php/i.test(response.url())) return;
    probe.status = response.status();
    void response
      .text()
      .then((body) => {
        probe.body = body.slice(0, 400);
      })
      .catch(() => undefined);
  };
  const onConsole = (message: ConsoleMessage): void => {
    if (message.type() !== "error" || probe.consoleErrors.length >= 20) return;
    probe.consoleErrors.push(message.text().slice(0, 200));
  };
  page.on("request", onRequest);
  page.on("requestfailed", onRequestFailed);
  page.on("response", onResponse);
  page.on("console", onConsole);

  try {
    // Playwright's synthetic click does not reliably fire this inline
    // `onclick="login()"` link (a human click works, the automated one can be a
    // no-op). Click, then confirm login() actually ran — if not, call it directly.
    await signInControlLocator(page)
      .click({ timeout: 10_000 })
      .catch((error) => {
        console.warn(`Sign In click failed (${(error as Error).message}) — invoking login() directly.`);
      });
    await page.waitForTimeout(300);
    const invokedAfterClick = await page
      .evaluate(() => (window as unknown as { __msoLogin?: { invoked: number } }).__msoLogin?.invoked ?? 0)
      .catch(() => 0);
    if (invokedAfterClick === 0) {
      console.warn("Sign In click did not invoke the portal's login() handler — invoking it directly.");
      await page
        .evaluate(() => (window as unknown as { login?: () => unknown }).login?.())
        .catch(() => undefined);
    }

    // login() RSA-encrypts the values and submits via AJAX; wait for the form to
    // actually go away.
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2_000);
      if (!(await isLoginFormVisible(page, 1_000))) return;
    }

    const invocation = await page
      .evaluate(() => (window as unknown as { __msoLogin?: { invoked: number; error: string | null } }).__msoLogin)
      .catch(() => undefined);
    if (invocation) {
      probe.invoked = invocation.invoked > 0;
      if (invocation.error) probe.scriptError = invocation.error;
    }
  } finally {
    page.off("request", onRequest);
    page.off("requestfailed", onRequestFailed);
    page.off("response", onResponse);
    page.off("console", onConsole);
  }

  throw new NeedsHumanLoginError(
    `Automatic sign-in failed; the login form is still visible — ${describeSignInProbe(probe)}. ` +
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
