import fs from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright";
import { waitForHumanCheck } from "./browser.js";
import { config } from "./config.js";
import { redactPasswordValues } from "./utils.js";

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
  await page.waitForLoadState("networkidle", { timeout: 45_000 }).catch(() => undefined);
  await page.waitForTimeout(3_000);

  const robot = page.getByText("I'm not a robot");
  if (!(await robot.isVisible({ timeout: 3_000 }).catch(() => false))) return;

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
      if (!(await robot.isVisible({ timeout: 3_000 }).catch(() => false))) return;
    }
  }
}

/** Fill the login form deterministically and submit. Throws on failure. */
async function performSignIn(page: Page, username: string, password: string): Promise<void> {
  // Set the values via evaluate so Chrome's autofill/overlays cannot race or
  // clear them before login() reads the fields.
  await page.evaluate(
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
  );

  const actualUser = await page.locator("#user_names").inputValue().catch(() => "");
  const actualPass = await page.locator("#password").inputValue().catch(() => "");
  if (!actualUser || !actualPass) {
    throw new NeedsHumanLoginError("Failed to set login credentials on the form.");
  }

  // Tick the "I'm not a robot" checkbox deterministically and verify.
  await page.evaluate(() => {
    const box = document.querySelector("#imrobot") as HTMLInputElement | null;
    if (!box) throw new Error("robot checkbox not found");
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const checked = await page.locator("#imrobot").isChecked().catch(() => false);
  if (!checked) await page.locator("#imrobot").check({ force: true }).catch(() => undefined);

  console.log("Login form detected — signing in automatically...");
  await page.getByText("Sign In", { exact: true }).click();

  // login() RSA-encrypts the values and submits via AJAX; wait for the form to
  // actually go away.
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2_000);
    const formGone = await page
      .getByText("I'm not a robot")
      .isVisible({ timeout: 1_000 })
      .catch(() => false);
    if (!formGone) return;
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
