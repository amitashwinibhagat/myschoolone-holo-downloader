// Deterministic daily downloader for the Chaman Bhartiya MySchoolOne portal.
// Logs in (Edge autofill), opens Dashboard > Daily Log inside the app frame,
// walks the date picker back over the last LOOKBACK_DAYS days and downloads
// every attachment link. No Holo API calls are needed for this path;
// `npm run agent` remains available as an exploratory fallback.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Frame, Page } from "playwright";
import { launchBrowser, waitForHumanCheck } from "./browser.js";
import { config } from "./config.js";
import { DownloadManager } from "./downloads.js";
import { DownloadStore } from "./store.js";
import { dateInIndia, sleep } from "./utils.js";

const ATTACHMENT_PATTERN = /UploadFiles/i;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 60_000;

const exec = promisify(execFile);

interface RunTotals {
  saved: number;
  duplicates: number;
  failures: string[];
  daysChecked: number;
}

async function notify(title: string, message: string): Promise<void> {
  const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
  await exec("osascript", ["-e", script]).catch(() => undefined);
}

/** IST calendar date `daysAgo` days back, as folder label and portal format. */
function istDate(daysAgo: number): { iso: string; portal: string } {
  const iso = dateInIndia(new Date(Date.now() - daysAgo * 86_400_000));
  const [year, month, day] = iso.split("-");
  return { iso, portal: `${day}/${month}/${year}` };
}

function appFrame(page: Page): Frame {
  // The portal is an old-style frameset; all content lives in the child frame.
  return page.frames().find((frame) => frame !== page.mainFrame()) || page.mainFrame();
}

async function ensureLoggedIn(page: Page): Promise<void> {
  await waitForHumanCheck(page);
  await page.waitForLoadState("networkidle", { timeout: 45_000 }).catch(() => undefined);
  await page.waitForTimeout(3_000);

  const robot = page.getByText("I'm not a robot");
  if (!(await robot.isVisible({ timeout: 3_000 }).catch(() => false))) return;

  const username = await page.locator("input").first().inputValue().catch(() => "");
  if (!username) {
    throw new Error(
      "Login form is showing but the browser did not autofill credentials. " +
        "Run `npm run login`, sign in once and let Edge save the password.",
    );
  }

  console.log("Login form detected — signing in with autofilled credentials...");
  await robot.click();
  await page.waitForTimeout(2_000);
  await page.getByText("Sign In", { exact: true }).click();
  await page.waitForTimeout(8_000);

  if (await page.getByText("I'm not a robot").isVisible({ timeout: 2_000 }).catch(() => false)) {
    throw new Error("Automatic sign-in failed; the login form is still visible. Run `npm run login` manually.");
  }
}

async function openDailyLog(page: Page): Promise<Frame> {
  // Navigate the app frame straight to the Daily Log page — far more reliable
  // than clicking through the collapsible sidebar menu.
  const url = new URL("/Web/LearningManagement/daily_planner_parent.php", config.schoolUrl).toString();
  const frame = appFrame(page);
  await frame.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(4_000);

  const current = appFrame(page);
  if ((await current.locator("#dailydate").count().catch(() => 0)) > 0) return current;

  // Fallback: click through the sidebar (entry expands a submenu whose last
  // visible match is the page link).
  const sidebar = current.locator("text=/daily\\s*log/i").locator("visible=true").first();
  await sidebar.waitFor({ state: "visible", timeout: 30_000 });
  await sidebar.click();
  await page.waitForTimeout(2_000);
  await current.locator("text=/daily\\s*log/i").locator("visible=true").last().click();
  await page.waitForTimeout(6_000);
  return appFrame(page);
}

/** Switches the Daily Log to a specific date via the page's own date field. */
async function selectDate(page: Page, frame: Frame, portalDate: string): Promise<boolean> {
  const changed = await frame.evaluate((value) => {
    const input = document.querySelector<HTMLInputElement>("#dailydate");
    const loader = (window as { displaysubjects?: (value: string) => void }).displaysubjects;
    if (!input || typeof loader !== "function") return false;
    input.value = value;
    loader(value);
    return true;
  }, portalDate).catch(() => false);
  if (changed) await page.waitForTimeout(5_000);
  return changed;
}

async function collectAttachmentUrls(frame: Frame): Promise<string[]> {
  const urls = await frame.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"), (anchor) => anchor.href),
  );
  return [...new Set(urls.filter((url) => ATTACHMENT_PATTERN.test(url)))];
}

async function downloadAll(
  page: Page,
  downloads: DownloadManager,
  urls: string[],
  dateLabel: string,
  totals: RunTotals,
): Promise<void> {
  for (const url of urls) {
    try {
      const result = await downloads.saveFromUrl(page, url, "", dateLabel);
      if (result.saved) {
        totals.saved += 1;
        console.log(`  ✓ Saved ${result.path}`);
      } else if (result.duplicate) {
        totals.duplicates += 1;
      } else if (result.reason) {
        totals.failures.push(`${url.slice(-40)}: ${result.reason}`);
      }
    } catch (error) {
      totals.failures.push(`${url.slice(-40)}: ${(error as Error).message}`);
    }
  }
}

async function attempt(store: DownloadStore): Promise<RunTotals> {
  const downloads = new DownloadManager(store);
  let browser;
  try {
    browser = await launchBrowser(downloads);
  } catch (error) {
    if ((error as Error).message.includes("existing browser session")) {
      throw new Error(
        "The browser profile is locked by another Edge window (probably left open from a manual run). " +
          "Close that Edge window and re-run.",
      );
    }
    throw error;
  }

  const totals: RunTotals = { saved: 0, duplicates: 0, failures: [], daysChecked: 0 };
  try {
    const page = browser.getPage();
    await page.goto(config.schoolUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await ensureLoggedIn(page);
    const frame = await openDailyLog(page);

    // Walk back day by day so every image lands in its correct date folder.
    for (let daysAgo = 0; daysAgo < config.lookbackDays; daysAgo += 1) {
      const { iso, portal } = istDate(daysAgo);
      if (!(await selectDate(page, appFrame(page), portal))) {
        // Date picker missing (page layout changed) — harvest whatever is shown.
        console.log("Date picker not available — harvesting the default view only.");
        await downloadAll(page, downloads, await collectAttachmentUrls(frame), dateInIndia(), totals);
        totals.daysChecked += 1;
        break;
      }
      const urls = await collectAttachmentUrls(appFrame(page));
      console.log(`${iso}: ${urls.length} attachment link(s).`);
      await downloadAll(page, downloads, urls, iso, totals);
      totals.daysChecked += 1;
    }

    return totals;
  } catch (error) {
    const dir = path.resolve("debug");
    await fs.mkdir(dir, { recursive: true });
    await browser.getPage().screenshot({ path: path.join(dir, "daily-failure.png") }).catch(() => undefined);
    throw error;
  } finally {
    await browser.context.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const store = new DownloadStore(config.stateDir);
  await store.load();

  const lastRun = store.lastSuccessfulRunAt();
  if (!force && lastRun && dateInIndia(new Date(lastRun)) === dateInIndia()) {
    console.log("Already completed a successful run today — skipping. Use --force to re-run.");
    return;
  }

  let lastError: Error | undefined;
  for (let attemptNumber = 1; attemptNumber <= MAX_ATTEMPTS; attemptNumber += 1) {
    try {
      const totals = await attempt(store);
      await store.markSuccessfulRun();
      const summary = `${totals.saved} new, ${totals.duplicates} duplicates, ${totals.failures.length} failed (${totals.daysChecked} day view(s) checked).`;
      console.log(`\nDone: ${summary}`);
      for (const failure of totals.failures) console.log(`  ! ${failure}`);
      await notify(
        "School photos",
        totals.saved > 0 ? `${totals.saved} new photo(s) saved to Downloads.` : "No new photos today.",
      );
      return;
    } catch (error) {
      lastError = error as Error;
      console.error(`Attempt ${attemptNumber}/${MAX_ATTEMPTS} failed: ${lastError.message}`);
      if (attemptNumber < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
    }
  }

  await notify("School photos — FAILED", lastError?.message.slice(0, 180) || "Unknown error");
  throw lastError;
}

main().catch((error) => {
  console.error(`\nFatal error: ${(error as Error).stack || (error as Error).message}`);
  process.exitCode = 1;
});
