import fs from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright";
import { waitForHumanCheck } from "./browser.js";
import { config } from "./config.js";

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
 * in .env when set (fully automatic); otherwise the browser's autofilled
 * values are used. Throws NeedsHumanLoginError when sign-in cannot be
 * completed without a human.
 */
export async function ensureLoggedIn(page: Page): Promise<void> {
  await waitForHumanCheck(page);
  await page.waitForLoadState("networkidle", { timeout: 45_000 }).catch(() => undefined);
  await page.waitForTimeout(3_000);

  const robot = page.getByText("I'm not a robot");
  if (!(await robot.isVisible({ timeout: 3_000 }).catch(() => false))) return;

  const usernameField = page.locator("#user_names");
  const passwordField = page.locator("#password");
  if ((await usernameField.count()) === 0 || (await passwordField.count()) === 0) {
    throw new NeedsHumanLoginError(
      "Login form is showing but its username/password fields were not found. " +
        "The portal layout may have changed — run `npm run login` manually.",
    );
  }

  // Prefer explicit credentials from .env; fall back to whatever the browser
  // autofilled into the real fields.
  let username = config.schoolUsername;
  let password = config.schoolPassword;
  if (!username || !password) {
    username = username || (await usernameField.inputValue().catch(() => ""));
    password = password || (await passwordField.inputValue().catch(() => ""));
  }
  if (!username || !password) {
    throw new NeedsHumanLoginError(
      "Login form is showing but no credentials are available. Set " +
        "SCHOOL_USERNAME and SCHOOL_PASSWORD in .env for automatic re-login, " +
        "or run `npm run login` once.",
    );
  }

  console.log("Login form detected — signing in automatically...");
  await usernameField.fill(username);
  await passwordField.fill(password);

  // Tick the "I'm not a robot" checkbox (label toggles #imrobot) and verify.
  await robot.click();
  const robotChecked = await page
    .locator("#imrobot")
    .isChecked()
    .catch(() => false);
  if (!robotChecked) {
    await page.locator("#imrobot").check({ force: true }).catch(() => undefined);
  }

  // The Sign In anchor calls login(), which RSA-encrypts the values and
  // submits via AJAX. Click it and wait for the form to actually go away.
  await page.getByText("Sign In", { exact: true }).click();

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2_000);
    const formStillVisible = await robot.isVisible({ timeout: 1_000 }).catch(() => false);
    if (!formStillVisible) return; // signed in — form is gone
  }

  throw new NeedsHumanLoginError(
    "Automatic sign-in failed; the login form is still visible. " +
      "Check SCHOOL_USERNAME/SCHOOL_PASSWORD in .env, or run `npm run login` manually.",
  );
}

/** Write a screenshot + page HTML snapshot for failure diagnostics. */
export async function writeFailureDebug(page: Page, label: string): Promise<void> {
  const dir = path.join(config.debugDir, new Date().toISOString().replace(/[:.]/g, "-"));
  await fs.mkdir(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${label}.png`) }).catch(() => undefined);
  await fs.writeFile(path.join(dir, "page.html"), await page.content().catch(() => ""));
}
