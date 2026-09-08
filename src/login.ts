import readline from "node:readline/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { waitForHumanCheck, withBrowserSession } from "./browser.js";
import { config } from "./config.js";

/** Escape a value for dotenv double-quoted syntax. */
function dotenvQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Persist credentials to .env so future session expiries can be handled
 * automatically (without relying on Chrome's flaky autofill). Skipped when
 * SCHOOL_USERNAME/SCHOOL_PASSWORD are already configured.
 */
async function saveCredentials(username?: string, password?: string): Promise<void> {
  if (config.schoolUsername && config.schoolPassword) return;
  const envPath = path.resolve(".env");
  const existing = await fs.readFile(envPath, "utf8").catch(() => "");
  if (/^SCHOOL_USERNAME=/m.test(existing) || /^SCHOOL_PASSWORD=/m.test(existing)) return;

  if (!username || !password) {
    console.log("\nNote: SCHOOL_USERNAME / SCHOOL_PASSWORD were not saved automatically.");
    console.log("Add them to .env if you want fully automatic re-login on future session expiries.");
    return;
  }

  const lines = [
    "",
    "# Auto-saved by `npm run login` for automatic re-login. Plaintext — keep .env private.",
    `SCHOOL_USERNAME=${dotenvQuote(username)}`,
    `SCHOOL_PASSWORD=${dotenvQuote(password)}`,
    "",
  ];
  await fs.appendFile(envPath, lines.join("\n"));
  await fs.chmod(envPath, 0o600).catch(() => undefined);
  console.log("Saved SCHOOL_USERNAME/SCHOOL_PASSWORD to .env for automatic re-login.");
}

async function main(): Promise<void> {
  await withBrowserSession("manual", "manual", async ({ page, browser }) => {
    await page.goto(config.schoolUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await waitForHumanCheck(page);

    console.log("\nLog in to MySchoolOne Pro manually in the opened Chromium window.");
    console.log("Complete any OTP/CAPTCHA and navigate until you can see the parent dashboard.");

    // Continuously sample form fields while the login page is active so credentials
    // are captured before submission navigates to the dashboard.
    let capturedUsername = "";
    let capturedPassword = "";
    const sampler = setInterval(async () => {
      try {
        const u = await page.locator("#user_names").inputValue().catch(() => "");
        const p = await page.locator("#password").inputValue().catch(() => "");
        if (u) capturedUsername = u;
        if (p) capturedPassword = p;
      } catch {
        // Page navigated or inputs unmounted
      }
    }, 500);

    const terminal = readline.createInterface({ input, output });
    try {
      await terminal.question("\nPress Enter here after the dashboard is fully visible...");
    } finally {
      terminal.close();
      clearInterval(sampler);
    }

    await saveCredentials(capturedUsername, capturedPassword);

    await fs.mkdir(config.stateDir, { recursive: true });
    await browser.context.storageState({ path: config.sessionStatePath });
    await fs.chmod(config.sessionStatePath, 0o600);
    console.log(`Login session saved locally in: ${config.profileDir}`);
    console.log(`Direct-poll session snapshot saved in: ${config.sessionStatePath}`);
  });
}

main().catch((error) => {
  console.error((error as Error).stack || (error as Error).message);
  process.exitCode = 1;
});
