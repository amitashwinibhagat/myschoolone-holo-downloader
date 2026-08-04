import readline from "node:readline/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { launchBrowser, waitForHumanCheck } from "./browser.js";
import { config } from "./config.js";
import { DownloadManager } from "./downloads.js";
import { DownloadStore } from "./store.js";
import { acquireRunLock } from "./run-lock.js";

/** Escape a value for dotenv double-quoted syntax. */
function dotenvQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * After a successful manual login, read the credentials from the filled login
 * fields and persist them to .env so future session expiries can be handled
 * automatically (without relying on Chrome's flaky autofill). Skipped when
 * SCHOOL_USERNAME/SCHOOL_PASSWORD are already configured.
 */
async function saveCredentialsFromBrowser(page: import("playwright").Page): Promise<void> {
  if (config.schoolUsername && config.schoolPassword) return;
  const envPath = path.resolve(".env");
  const existing = await fs.readFile(envPath, "utf8").catch(() => "");
  if (/^SCHOOL_USERNAME=/m.test(existing) || /^SCHOOL_PASSWORD=/m.test(existing)) return;

  const username = await page.locator("#user_names").inputValue().catch(() => "");
  const password = await page.locator("#password").inputValue().catch(() => "");
  if (!username || !password) return;

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
  const store = new DownloadStore(config.stateDir);
  await store.load();
  const downloads = new DownloadManager(store);
  const lock = await acquireRunLock(config.stateDir, "manual", "manual");
  if (!lock.acquired) throw new Error("Another downloader command is using the browser profile. Wait for it to finish.");
  try {
    const browser = await launchBrowser(downloads);
    try {
      const page = browser.getPage();
      await page.goto(config.schoolUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await waitForHumanCheck(page);

      console.log("\nLog in to MySchoolOne Pro manually in the opened Chromium window.");
      console.log("Complete any OTP/CAPTCHA and navigate until you can see the parent dashboard.");
      const terminal = readline.createInterface({ input, output });
      await terminal.question("\nPress Enter here after the dashboard is fully visible...");
      terminal.close();

      await saveCredentialsFromBrowser(page);

      await fs.mkdir(config.stateDir, { recursive: true });
      await browser.context.storageState({ path: config.sessionStatePath });
      await fs.chmod(config.sessionStatePath, 0o600);
      console.log(`Login session saved locally in: ${config.profileDir}`);
      console.log(`Direct-poll session snapshot saved in: ${config.sessionStatePath}`);
    } finally {
      await browser.context.close();
    }
  } finally {
    await lock.release();
  }
}

main().catch((error) => {
  console.error((error as Error).stack || (error as Error).message);
  process.exitCode = 1;
});
