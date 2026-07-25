import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { launchBrowser } from "./browser.js";
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

  console.log("Navigate manually to the page or attachment viewer that is causing trouble.");
  const terminal = readline.createInterface({ input, output });
  await terminal.question("Press Enter to capture the current page...");
  terminal.close();

  const dir = path.resolve("debug", new Date().toISOString().replace(/[:.]/g, "-"));
  await fs.mkdir(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, "screen.png"), fullPage: false });
  await fs.writeFile(path.join(dir, "page.html"), await page.content());
  await fs.writeFile(path.join(dir, "visible-text.txt"), await page.locator("body").innerText().catch(() => ""));
  console.log(`Debug capture saved in ${dir}`);
  await browser.context.close();
}

main().catch((error) => {
  console.error((error as Error).stack || (error as Error).message);
  process.exitCode = 1;
});
