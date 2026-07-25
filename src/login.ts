import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { launchBrowser, waitForHumanCheck } from "./browser.js";
import { config } from "./config.js";
import { DownloadManager } from "./downloads.js";
import { DownloadStore } from "./store.js";

async function main(): Promise<void> {
  const store = new DownloadStore(config.stateDir);
  await store.load();
  const downloads = new DownloadManager(store);
  const browser = await launchBrowser(downloads);
  const page = browser.getPage();
  await page.goto(config.schoolUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await waitForHumanCheck(page);

  console.log("\nLog in to MySchoolOne Pro manually in the opened Chromium window.");
  console.log("Complete any OTP/CAPTCHA and navigate until you can see the parent dashboard.");
  const terminal = readline.createInterface({ input, output });
  await terminal.question("\nPress Enter here after the dashboard is fully visible...");
  terminal.close();

  console.log(`Login session saved locally in: ${config.profileDir}`);
  await browser.context.close();
}

main().catch((error) => {
  console.error((error as Error).stack || (error as Error).message);
  process.exitCode = 1;
});
