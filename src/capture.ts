import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { launchBrowser } from "./browser.js";
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

      console.log("Navigate manually to the page or attachment viewer that is causing trouble.");
      const terminal = readline.createInterface({ input, output });
      await terminal.question("Press Enter to capture the current page...");
      terminal.close();

      const dir = path.join(config.debugDir, new Date().toISOString().replace(/[:.]/g, "-"));
      await fs.mkdir(dir, { recursive: true });
      await page.screenshot({ path: path.join(dir, "screen.png"), fullPage: false });
      await fs.writeFile(path.join(dir, "page.html"), await page.content());
      await fs.writeFile(path.join(dir, "visible-text.txt"), await page.locator("body").innerText().catch(() => ""));
      console.log(`Debug capture saved in ${dir}`);
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
