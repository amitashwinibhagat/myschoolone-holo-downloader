// One-time backfill: uses the portal's "Previous Year Log" page to download
// all EY1 photo attachments across a date range. Processes month-by-month.
//
// Usage:
//   npx tsx src/backfill.ts --from 2025-10-01 --to 2026-04-30
import fs from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright";
import { launchBrowser } from "./browser.js";
import { config } from "./config.js";
import { DownloadManager } from "./downloads.js";
import { DownloadStore } from "./store.js";
import { acquireRunLock } from "./run-lock.js";
import { appFrame, ensureLoggedIn, writeFailureDebug } from "./portal.js";
import { notify } from "./notify.js";

const PROGRESS_FILE = path.join(config.stateDir, "backfill-progress.json");

interface BackfillProgress {
  lastCompletedMonth: string;
}

interface Totals {
  saved: number;
  duplicates: number;
  failures: string[];
  monthsProcessed: number;
}

function parseArgs(): { from: Date; to: Date } {
  const args = process.argv.slice(2);
  const fromIdx = args.indexOf("--from");
  const toIdx = args.indexOf("--to");
  if (fromIdx === -1 || toIdx === -1) {
    console.error("Usage: npx tsx src/backfill.ts --from 2025-10-01 --to 2026-04-30");
    process.exit(1);
  }
  const from = new Date(args[fromIdx + 1] + "T00:00:00+05:30");
  const to = new Date(args[toIdx + 1] + "T00:00:00+05:30");
  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    console.error("Invalid date format. Use YYYY-MM-DD.");
    process.exit(1);
  }
  return { from, to };
}

/** Generate month chunks: [{start: "01/10/2025", end: "31/10/2025", label: "2025-10"}, ...] */
function monthChunks(from: Date, to: Date): { start: string; end: string; label: string }[] {
  const chunks: { start: string; end: string; label: string }[] = [];
  const cursor = new Date(from.getFullYear(), from.getMonth(), 1);
  while (cursor <= to) {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const startDay = cursor.getTime() >= from.getTime() ? from.getDate() : 1;
    const lastDay = new Date(year, month + 1, 0).getDate();
    const endDay = new Date(year, month, lastDay).getTime() <= to.getTime() ? lastDay : to.getDate();
    const mm = String(month + 1).padStart(2, "0");
    chunks.push({
      start: `${String(startDay).padStart(2, "0")}/${mm}/${year}`,
      end: `${String(endDay).padStart(2, "0")}/${mm}/${year}`,
      label: `${year}-${mm}`,
    });
    cursor.setMonth(month + 1, 1);
  }
  return chunks;
}

async function loadProgress(): Promise<BackfillProgress | null> {
  try {
    return JSON.parse(await fs.readFile(PROGRESS_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function saveProgress(monthLabel: string): Promise<void> {
  await fs.mkdir(path.dirname(PROGRESS_FILE), { recursive: true });
  await fs.writeFile(PROGRESS_FILE, JSON.stringify({ lastCompletedMonth: monthLabel }, null, 2));
}

async function openPreviousYearLog(page: Page): Promise<Frame> {
  // Step 1: Open the Daily Log page (same navigation as daily.ts).
  const url = new URL("/Web/LearningManagement/daily_planner_parent.php", config.schoolUrl).toString();
  const frame = appFrame(page);
  await frame.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(4_000);

  const current = appFrame(page);

  // Step 2: Click the "Previous year log" tab (3rd tab on the page).
  const tab = current.locator("text=/previous\\s*year\\s*log/i").first();
  await tab.waitFor({ state: "visible", timeout: 15_000 });
  await tab.click();
  await page.waitForTimeout(4_000);

  // Verify the search form appeared.
  const result = appFrame(page);
  const hasSearch = (await result.locator("text=/search/i").count().catch(() => 0)) > 0;
  if (!hasSearch) {
    throw new Error("Clicked 'Previous year log' tab but the search form did not appear.");
  }
  console.log("Navigated to Previous Year Log tab.");
  return result;
}

/** Set the date range and click Search. Returns the frame with results. */
async function searchDateRange(page: Page, frame: Frame, startDate: string, endDate: string): Promise<void> {
  // Clear and fill start date input.
  const startInput = frame.locator("input").nth(0);
  const endInput = frame.locator("input").nth(1);

  // Use evaluate to set values directly (date inputs can be finicky with Playwright fill).
  await frame.evaluate(
    ({ start, end }) => {
      const inputs = document.querySelectorAll<HTMLInputElement>("input[type='text'], input:not([type])");
      // Find the date inputs by their current value pattern (DD/MM/YYYY).
      const dateInputs = Array.from(inputs).filter(
        (el) => /\d{2}\/\d{2}\/\d{4}/.test(el.value) || el.placeholder?.includes("/") || el.name?.toLowerCase().includes("date"),
      );
      if (dateInputs.length >= 2) {
        dateInputs[0].value = start;
        dateInputs[1].value = end;
      } else if (inputs.length >= 2) {
        // Fallback: try the first two visible text inputs after the dropdown.
        inputs[0].value = start;
        inputs[1].value = end;
      }
    },
    { start: startDate, end: endDate },
  );
  await page.waitForTimeout(1_000);

  // Click the Search button.
  const searchBtn = frame.locator("text=/search/i").first();
  await searchBtn.click();
  // Wait for results to load (the table populates via AJAX).
  await page.waitForTimeout(8_000);
}

/** Collect all image URLs from the results table (thumbnails + links). */
async function collectImageUrls(frame: Frame): Promise<string[]> {
  const urls = await frame.evaluate(() => {
    const found = new Set<string>();
    // Images embedded as <img> thumbnails in the table.
    for (const img of document.querySelectorAll<HTMLImageElement>("img[src]")) {
      const src = img.src;
      // Skip tiny icons, logos, and UI elements.
      if (img.naturalWidth > 0 && img.naturalWidth < 50) continue;
      if (/logo|icon|sprite|avatar|placeholder/i.test(src)) continue;
      if (/UploadFiles|cloudfront|\.jpe?g|\.png|\.webp|\.gif/i.test(src)) {
        found.add(src);
      }
    }
    // Attachment links (same pattern as daily.ts).
    for (const anchor of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      if (/UploadFiles/i.test(anchor.href)) found.add(anchor.href);
    }
    return [...found];
  });
  return urls;
}

/** Extract date labels from the purple date separator bars in the table. */
async function collectDateLabels(frame: Frame): Promise<string[]> {
  return frame.evaluate(() => {
    // The date separators are typically in their own row or styled element.
    const labels: string[] = [];
    const cells = document.querySelectorAll("td, div, span");
    for (const cell of cells) {
      const text = cell.textContent?.trim() || "";
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(text)) labels.push(text);
    }
    return [...new Set(labels)];
  });
}

async function main(): Promise<void> {
  const { from, to } = parseArgs();
  const chunks = monthChunks(from, to);
  console.log(`EY1 Backfill: ${chunks[0].label} → ${chunks[chunks.length - 1].label} (${chunks.length} months)\n`);

  const progress = await loadProgress();
  let startIndex = 0;
  if (progress?.lastCompletedMonth) {
    startIndex = chunks.findIndex((c) => c.label === progress.lastCompletedMonth) + 1;
    if (startIndex > 0 && startIndex < chunks.length) {
      console.log(`Resuming after ${progress.lastCompletedMonth}\n`);
    } else if (startIndex >= chunks.length) {
      console.log("Backfill already completed. Delete .state/backfill-progress.json to re-run.");
      return;
    }
  }

  const store = new DownloadStore(config.stateDir);
  await store.load();
  const downloads = new DownloadManager(store);
  const lock = await acquireRunLock(config.stateDir, "manual", "manual");
  if (!lock.acquired) throw new Error("Another downloader command is using the browser profile. Wait for it to finish.");

  try {
    const browser = await launchBrowser(downloads);
    const totals: Totals = { saved: 0, duplicates: 0, failures: [], monthsProcessed: 0 };
    try {
      const page = browser.getPage();
      await page.goto(config.schoolUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await ensureLoggedIn(page);
      const frame = await openPreviousYearLog(page);

      for (let i = startIndex; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        console.log(`\n[${chunk.label}] Searching ${chunk.start} → ${chunk.end} ...`);

        await searchDateRange(page, appFrame(page), chunk.start, chunk.end);

        const currentFrame = appFrame(page);
        const imageUrls = await collectImageUrls(currentFrame);
        console.log(`[${chunk.label}] Found ${imageUrls.length} image(s).`);

        // Use the month label as the date folder (e.g. "2025-10").
        for (const url of imageUrls) {
          try {
            const result = await downloads.saveFromUrl(page, url, "", chunk.label);
            if (result.saved) {
              totals.saved += 1;
              console.log(`  ✓ ${result.path}`);
            } else if (result.duplicate) {
              totals.duplicates += 1;
            } else if (result.reason) {
              totals.failures.push(`${chunk.label} ${url.slice(-50)}: ${result.reason}`);
            }
          } catch (error) {
            totals.failures.push(`${chunk.label} ${url.slice(-50)}: ${(error as Error).message}`);
          }
        }

        totals.monthsProcessed += 1;
        await saveProgress(chunk.label);
        console.log(`[${chunk.label}] Done — running total: ${totals.saved} saved, ${totals.duplicates} dupes.`);
      }

      await downloads.flush();

      const summary =
        `EY1 Backfill complete (${totals.monthsProcessed} months)\n` +
        `✓ ${totals.saved} new | ${totals.duplicates} duplicates | ${totals.failures.length} failed`;
      console.log(`\n${summary}`);
      if (totals.failures.length > 0) {
        console.log("\nFailures:");
        for (const f of totals.failures.slice(0, 30)) console.log(`  ! ${f}`);
        if (totals.failures.length > 30) console.log(`  ... and ${totals.failures.length - 30} more`);
      }
      await notify("EY1 Backfill", summary);
    } catch (error) {
      await writeFailureDebug(browser.getPage(), "backfill-failure");
      await notify("EY1 Backfill — INTERRUPTED", (error as Error).message.slice(0, 200));
      throw error;
    } finally {
      await browser.context.close().catch(() => undefined);
    }
  } finally {
    await lock.release();
  }
}

main().catch((error) => {
  console.error(`\nFatal: ${(error as Error).stack || (error as Error).message}`);
  process.exitCode = 1;
});
