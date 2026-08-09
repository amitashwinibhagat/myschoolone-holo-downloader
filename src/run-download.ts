import type { Frame, Page } from "playwright";
import { launchBrowser } from "./browser.js";
import { config } from "./config.js";
import { DownloadManager } from "./downloads.js";
import { DownloadStore, type RunTransport } from "./store.js";
import { observeDailyLogRequests } from "./direct-discovery.js";
import {
  directPollAttachments,
  isDirectPollAvailable,
  fetchAttachmentBuffer,
  loadCookies,
  type DirectPollOutcome,
} from "./direct-api.js";
import { appFrame, ensureLoggedIn, NeedsHumanLoginError, writeFailureDebug } from "./portal.js";
import { checkSession } from "./session.js";
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

/**
 * Attempt downloads via direct HTTP requests (no browser).
 * Uses saved session cookies and the captured AJAX request structure to call
 * the portal's endpoints directly.
 */
async function directAttempt(
  store: DownloadStore,
  lookbackDays: number,
): Promise<{ totals: RunTotals; outcome: DirectPollOutcome; fetchErrors: number }> {
  const downloads = new DownloadManager(store);
  const totals: RunTotals = { saved: 0, duplicates: 0, failures: [], daysChecked: 0 };

  const outcome = await directPollAttachments(lookbackDays);
  let fetchErrors = 0;

  // Load cookies once for the whole batch, not once per day.
  const cookies = await loadCookies();

  for (const dayResult of outcome.results) {
    totals.daysChecked += 1;
    if (dayResult.error) {
      fetchErrors += 1;
      totals.failures.push(`${dayResult.dateLabel}: ${dayResult.error}`);
      continue;
    }
    if (dayResult.urls.length === 0) continue;

    for (const url of dayResult.urls) {
      try {
        const downloaded = await fetchAttachmentBuffer(cookies, url);
        if (!downloaded) {
          totals.failures.push(`${url.slice(-40)}: HTTP request failed`);
          continue;
        }

        // Determine a reasonable filename from the URL.
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

  return { totals, outcome, fetchErrors };
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
    await writeFailureDebug(browser.getPage(), "daily-failure");
    throw error;
  } finally {
    await browser.context.close().catch(() => undefined);
  }
}

/**
 * Decide whether a direct-poll outcome should be trusted or require a browser
 * fallback. We distrust the direct result when:
 * - any fetch-level error occurred (session/endpoint problem the browser can
 *   recover from — and it refreshes the discovery file), or
 * - nothing was found across the ENTIRE lookback window. A stale captured
 *   `type` value could otherwise silently hide real photos until the discovery
 *   file expires, so an all-empty window is always verified once with the
 *   browser. (When at least one day yielded attachments, the direct result is
 *   trusted even if some days were empty.)
 */
export function directNeedsFallback(totals: RunTotals, outcome: DirectPollOutcome, fetchErrors: number): boolean {
  if (fetchErrors > 0) return true;
  const anyUrlsFound = totals.saved > 0 || totals.duplicates > 0;
  if (anyUrlsFound) return false;
  if (!outcome.discoveryUsed) return true;
  return true; // whole window empty → verify once with the browser
}

export async function runDownload(store: DownloadStore, lookbackDays: number): Promise<RunDownloadResult> {
  // Cheap session gate before deciding whether the direct path is worth trying.
  let session: Awaited<ReturnType<typeof checkSession>> | undefined;
  if (await isDirectPollAvailable()) {
    session = await checkSession().catch(() => undefined);
    if (session) {
      if (session.status === "ok" && session.cookiesExpiringSoon) {
        console.warn("Session cookies expire within 48h — run `npm run login` soon.");
      } else if (session.status === "expired") {
        console.log("Saved session expired — going straight to the browser (it can auto-sign-in).");
      } else if (session.status === "challenge") {
        console.log("Session check shows a bot challenge — using the browser path.");
      } else if (session.status === "unreachable") {
        console.warn(`Session check: portal unreachable (${session.reason}) — will still try the browser.`);
      }
    }
  }

  // Try direct-poll first — faster, no browser needed, no AI cost. Disabled by
  // DIRECT_POLL=false when the portal's AJAX endpoints reject raw requests.
  const directWorthTrying =
    config.directPoll &&
    (await isDirectPollAvailable()) &&
    (!session || session.status === "ok" || session.status === "challenge");
  if (directWorthTrying) {
    console.log("Attempting direct HTTP poll (no browser)...");
    try {
      const { totals, outcome, fetchErrors } = await directAttempt(store, lookbackDays);
      if (!directNeedsFallback(totals, outcome, fetchErrors)) {
        return { ...totals, transport: "direct" };
      }
      console.log("Direct poll inconclusive — falling back to browser to verify.");
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
      if (lastError instanceof NeedsHumanLoginError) {
        // A human must re-login; retrying immediately would just waste time.
        console.error("Login required — not retrying automatically.");
        break;
      }
      if (attemptNumber < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
    }
  }
  throw lastError || new Error("Download failed without an error message.");
}
