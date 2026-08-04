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
 * sign in with autofilled credentials. Throws NeedsHumanLoginError when the
 * browser cannot complete the sign-in on its own.
 */
export async function ensureLoggedIn(page: Page): Promise<void> {
  await waitForHumanCheck(page);
  await page.waitForLoadState("networkidle", { timeout: 45_000 }).catch(() => undefined);
  await page.waitForTimeout(3_000);

  const robot = page.getByText("I'm not a robot");
  if (!(await robot.isVisible({ timeout: 3_000 }).catch(() => false))) return;

  const username = await page.locator("input").first().inputValue().catch(() => "");
  if (!username) {
    throw new NeedsHumanLoginError(
      "Login form is showing but the browser did not autofill credentials. " +
        "Run `npm run login`, sign in once and save the password.",
    );
  }

  console.log("Login form detected — signing in with autofilled credentials...");
  await robot.click();
  await page.waitForTimeout(2_000);
  await page.getByText("Sign In", { exact: true }).click();
  await page.waitForTimeout(8_000);

  if (await page.getByText("I'm not a robot").isVisible({ timeout: 2_000 }).catch(() => false)) {
    throw new NeedsHumanLoginError(
      "Automatic sign-in failed; the login form is still visible. Run `npm run login` manually.",
    );
  }
}

/** Write a screenshot + page HTML snapshot for failure diagnostics. */
export async function writeFailureDebug(page: Page, label: string): Promise<void> {
  const dir = path.join(config.debugDir, new Date().toISOString().replace(/[:.]/g, "-"));
  await fs.mkdir(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${label}.png`) }).catch(() => undefined);
  await fs.writeFile(path.join(dir, "page.html"), await page.content().catch(() => ""));
}
