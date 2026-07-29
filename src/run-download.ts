import fs from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright";
import { launchBrowser, waitForHumanCheck } from "./browser.js";
import { config } from "./config.js";
import { DownloadManager } from "./downloads.js";
import { DownloadStore, type RunTransport } from "./store.js";
import { observeDailyLogRequests } from "./direct-discovery.js";
import { directPollAttachments, isDirectPollAvailable, fetchAttachmentBuffer } from "./direct-api.js";
import { dateInIndia, sleep } from "./utils.js";

const ATTACHMENT_PATTERN = /UploadFiles/i;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 60_000;

export interface RunTotals {
  saved: number;
  duplicates: number;
  failures: string[];
  daysChecked: number;
}

export interface RunDownloadResult extends RunTotals {
  transport: RunTransport;
}

/** IST calendar date `daysAgo` days back, as folder label and portal format. */
function istDate(daysAgo: number): { iso: string; portal: string } {
  const iso = dateInIndia(new Date(Date.now() - daysAgo * 86_400_000));
  const [year, month, day] = iso.split("-");
  return { iso, portal: `${day}/${month}/${year}` };
}

/**
 * Load cookies from the saved session state for direct HTTP requests.
 * Re-exported from direct-api for use in the run-download module.
 */
async function loadCookiesForDirect(): Promise<Array<{
  name: string;
  value: string;
  domain: string;
  path: string;
}>> {
  const fs_ = await import("node:fs/promises");
  const statePath = config.sessionStatePath;
  const raw = await fs_.readFile(statePath, "utf8");
  const state = JSON.parse(raw) as { cookies: Array<{ name: string; value: string; domain: string; path: string }> };
  return state.cookies || [];
}

function appFrame(page: Page): Frame {
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
        "Run `npm run login`, sign in once and save the password.",
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
  const url = new URL("/Web/LearningManagement/daily_planner_parent.php", config.schoolUrl).toString();
  const frame = appFrame(page);
  await frame.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(4_000);

  const current = appFrame(page);
  if ((await current.locator("#dailydate").count().catch(() => 0)) > 0) return current;

  const sidebar = current.locator("text=/daily\\s*log/i").locator("visible=true").first();
  await sidebar.waitFor({ state: "visible", timeout: 30_000 });
  await sidebar.click();
  await page.waitForTimeout(2_000);
  await current.locator("text=/daily\\s*log/i").locator("visible=true").last().click();
  await page.waitForTimeout(6_000);
  return appFrame(page);
}

async function selectDate(page: Page, frame: Frame, portalDate: string): Promise<boolean> {
  const changed = await frame
    .evaluate((value) => {
      const input = document.querySelector<HTMLInputElement>("#dailydate");
      const loader = (window as { displaysubjects?: (value: string) => void }).displaysubjects;
      if (!input || typeof loader !== "function") return false;
      input.value = value;
      loader(value);
      return true;
    }, portalDate)
    .catch(() => false);
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

async function writeFailureDebug(page: Page): Promise<void> {
  const dir = path.join(config.debugDir, new Date().toISOString().replace(/[:.]/g, "-"));
  await fs.mkdir(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, "daily-failure.png") }).catch(() => undefined);
  await fs.writeFile(path.join(dir, "page.html"), await page.content().catch(() => ""));
}

/**
 * Attempt downloads via direct HTTP requests (no browser).
 * Uses saved session cookies to call the portal's AJAX endpoints directly.
 */
async function directAttempt(store: DownloadStore, lookbackDays: number): Promise<RunTotals> {
  const downloads = new DownloadManager(store);
  const totals: RunTotals = { saved: 0, duplicates: 0, failures: [], daysChecked: 0 };

  const results = await directPollAttachments(lookbackDays);

  for (const dayResult of results) {
    totals.daysChecked += 1;
    if (dayResult.urls.length === 0) continue;

    // Load cookies once for the batch
    const cookies = await loadCookiesForDirect();

    for (const url of dayResult.urls) {
      try {
        const downloaded = await fetchAttachmentBuffer(cookies, url);
        if (!downloaded) {
          totals.failures.push(`${url.slice(-40)}: HTTP request failed`);
          continue;
        }

        // Determine a reasonable filename from the URL
        const urlParts = url.split("/");
        const rawName = decodeURIComponent(urlParts[urlParts.length - 1] || "school-photo");
        const suggestedName = rawName.split("?")[0] || "school-photo";

        const result = await downloads.saveFromBuffer(
          downloaded.buffer,
          url,
          downloaded.contentType,
          suggestedName,
          dayResult.dateLabel,
        );

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

  return totals;
}

async function browserAttempt(store: DownloadStore, lookbackDays: number): Promise<RunTotals> {
  const downloads = new DownloadManager(store);
  const browser = await launchBrowser(downloads);
  const totals: RunTotals = { saved: 0, duplicates: 0, failures: [], daysChecked: 0 };

  try {
    const page = browser.getPage();
    await page.goto(config.schoolUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await ensureLoggedIn(page);
    const frame = await openDailyLog(page);
    const flushDiscovery = observeDailyLogRequests(page);

    try {
      for (let daysAgo = 0; daysAgo < lookbackDays; daysAgo += 1) {
        const { iso, portal } = istDate(daysAgo);
        if (!(await selectDate(page, appFrame(page), portal))) {
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
    } finally {
      await flushDiscovery();
    }
    return totals;
  } catch (error) {
    await writeFailureDebug(browser.getPage());
    throw error;
  } finally {
    await browser.context.close().catch(() => undefined);
  }
}

export async function runDownload(store: DownloadStore, lookbackDays: number): Promise<RunDownloadResult> {
  // Try direct-poll first — faster, no browser needed, no AI cost.
  if (await isDirectPollAvailable()) {
    console.log("Attempting direct HTTP poll (no browser)...");
    try {
      const totals = await directAttempt(store, lookbackDays);
      if (totals.failures.length === 0 || totals.saved > 0) {
        return { ...totals, transport: "direct" };
      }
      console.log(`Direct poll had ${totals.failures.length} failures — falling back to browser.`);
    } catch (error) {
      console.warn(`Direct poll failed: ${(error as Error).message} — falling back to browser.`);
    }
  }

  // Fall back to browser-based download.
  let lastError: Error | undefined;
  for (let attemptNumber = 1; attemptNumber <= MAX_ATTEMPTS; attemptNumber += 1) {
    try {
      const totals = await browserAttempt(store, lookbackDays);
      return { ...totals, transport: attemptNumber > 1 ? "browser-fallback" : "browser" };
    } catch (error) {
      lastError = error as Error;
      console.error(`Attempt ${attemptNumber}/${MAX_ATTEMPTS} failed: ${lastError.message}`);
      if (attemptNumber < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
    }
  }
  throw lastError || new Error("Download failed without an error message.");
}
