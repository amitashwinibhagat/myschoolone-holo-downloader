import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { DownloadStore } from "./store.js";
import { nextRunInfo } from "./schedule-window.js";
import { isRunLockHeld } from "./run-lock.js";
import { summarize, formatStatusPlain } from "./status-format.js";
import { indiaTime } from "./utils.js";

const mode = process.argv.includes("--summary") ? "summary" : "full";

const store = new DownloadStore(config.stateDir);
await store.load();
const data = store.snapshot();
const records = data.records ?? [];

if (mode === "summary") {
  // Compact summary for notifications / quick glance
  console.log(formatStatusPlain(summarize(store)));
} else {
  // Full detailed output
  const summary = summarize(store);
  const lastRun = data.lastSuccessfulRunAt;
  console.log(`Download folder       : ${config.downloadDir}`);
  console.log(`State folder          : ${config.stateDir}`);
  console.log(`AI mode               : ${config.aiMode}`);
  console.log(`Total photos          : ${records.length}`);
  console.log(`Last good run         : ${lastRun ? new Date(lastRun).toLocaleString() : "never"}${summary.ranToday ? " (today ✓)" : ""}`);
  console.log(`Last scheduled attempt: ${data.lastScheduledAttemptAt ? new Date(data.lastScheduledAttemptAt).toLocaleString() : "never"}`);
  console.log(`Last reconciliation   : ${data.lastReconciliationAt ? new Date(data.lastReconciliationAt).toLocaleString() : "never"}`);
  console.log(`Last new photos       : ${data.lastNewPhotosAt ? new Date(data.lastNewPhotosAt).toLocaleString() : "never"}`);
  console.log(`Failure streak        : ${summary.consecutiveFailures}`);
  console.log(`Last transport        : ${summary.transport}`);

  console.log(`Photos this week      : ${summary.thisWeek}`);
  console.log(`Photos this month     : ${summary.thisMonth}`);

  // Failure rate (computed once in summarize, shared with the Telegram bot)
  console.log(`Recent failure rate   : ${summary.failureRate}% (${summary.failedRuns}/${summary.recentRunCount})`);

  const lockPath = path.join(config.stateDir, "run.lock", "owner.json");
  const lock = await fs.readFile(lockPath, "utf8").then(JSON.parse).catch(() => undefined);
  if (lock) {
    // A lock owned by a dead process is stale — the next run will clean it up.
    const active = await isRunLockHeld(config.stateDir);
    console.log(`Active lock           : ${lock.mode}/${lock.source} since ${lock.startedAt}${active ? "" : " (stale — owning process is dead)"}`);
  } else {
    console.log(`Active lock           : none`);
  }

  console.log(`Next schedule         : ${nextRunInfo(indiaTime())}`);

  const recentRunsDisplay = (data.runs ?? []).slice(-10).reverse();
  if (recentRunsDisplay.length > 0) {
    console.log("\nRecent runs:");
    for (const run of recentRunsDisplay) {
      const error = run.error ? ` — ${run.error.slice(0, 100)}` : "";
      console.log(
        `  ${new Date(run.startedAt).toLocaleString()}  ${run.source}/${run.mode} ${run.outcome}` +
          `  ${run.saved} new, ${run.duplicates} dupes, ${run.failures} failed (${run.transport})${error}`,
      );
    }
  }

  const byFolder = new Map<string, number>();
  for (const record of records) {
    const folder = path.basename(path.dirname(record.savedPath));
    byFolder.set(folder, (byFolder.get(folder) || 0) + 1);
  }
  const days = [...byFolder.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 10);
  if (days.length > 0) {
    console.log("\nRecent photo folders:");
    for (const [day, count] of days) console.log(`  ${day}  ${count} photo(s)`);
  }
}
