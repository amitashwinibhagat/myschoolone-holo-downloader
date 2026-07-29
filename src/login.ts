import readline from "node:readline/promises";
import fs from "node:fs/promises";
import { stdin as input, stdout as output } from "node:process";
import { launchBrowser, waitForHumanCheck } from "./browser.js";
import { config } from "./config.js";
import { DownloadManager } from "./downloads.js";
import { DownloadStore } from "./store.js";
import { acquireRunLock } from "./run-lock.js";

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
