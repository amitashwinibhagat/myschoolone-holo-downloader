import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { DownloadStore } from "./store.js";
import { dateInIndia, indiaTime } from "./utils.js";

const mode = process.argv.includes("--summary") ? "summary" : "full";

const store = new DownloadStore(config.stateDir);
await store.load();
const data = store.snapshot();
const records = data.records ?? [];

if (mode === "summary") {
  // Compact summary for notifications / quick glance
  const lastRun = data.lastSuccessfulRunAt;
  const ranToday = lastRun ? dateInIndia(new Date(lastRun)) === dateInIndia() : false;

  // Count photos this week (last 7 days)
  const weekAgo = Date.now() - 7 * 86_400_000;
  const thisWeek = records.filter((r) => new Date(r.downloadedAt).getTime() > weekAgo).length;

  // Count photos this month
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const thisMonth = records.filter((r) => new Date(r.downloadedAt).getTime() > monthStart.getTime()).length;

  // Failure rate from recent runs
  const recentRuns = (data.runs ?? []).slice(-20);
  const failedRuns = recentRuns.filter((r) => r.outcome === "failure").length;
  const failureRate = recentRuns.length > 0 ? Math.round((failedRuns / recentRuns.length) * 100) : 0;

  // Last successful run
  const lastRunStr = lastRun
    ? `${dateInIndia(new Date(lastRun))}${ranToday ? " (today)" : ""}`
    : "never";

  // Next scheduled run
  const clock = indiaTime();
  const weekday = clock.weekday >= 1 && clock.weekday <= 5;
  const nextRun = !weekday
    ? "next weekday 3PM IST"
    : clock.hour < 15
      ? "today 3PM IST"
      : clock.hour < 21
        ? "today 9PM IST"
        : "next weekday 3PM IST";

  // Transport used
  const transport = data.lastTransport || "unknown";

  console.log(`📸 Total: ${records.length} | This week: ${thisWeek} | This month: ${thisMonth}`);
  console.log(`✅ Last run: ${lastRunStr} | Failures: ${failureRate}% (${data.consecutiveFailures || 0} streak)`);
  console.log(`🔧 Transport: ${transport} | Next: ${nextRun}`);
} else {
  // Full detailed output
  const lastRun = data.lastSuccessfulRunAt;
  const ranToday = lastRun ? dateInIndia(new Date(lastRun)) === dateInIndia() : false;
  console.log(`Download folder       : ${config.downloadDir}`);
  console.log(`State folder          : ${config.stateDir}`);
  console.log(`AI mode               : ${config.aiMode}`);
  console.log(`Total photos          : ${records.length}`);
  console.log(`Last good run         : ${lastRun ? new Date(lastRun).toLocaleString() : "never"}${ranToday ? " (today ✓)" : ""}`);
  console.log(`Last scheduled attempt: ${data.lastScheduledAttemptAt ? new Date(data.lastScheduledAttemptAt).toLocaleString() : "never"}`);
  console.log(`Last reconciliation   : ${data.lastReconciliationAt ? new Date(data.lastReconciliationAt).toLocaleString() : "never"}`);
  console.log(`Last new photos       : ${data.lastNewPhotosAt ? new Date(data.lastNewPhotosAt).toLocaleString() : "never"}`);
  console.log(`Failure streak        : ${data.consecutiveFailures || 0}`);
  console.log(`Last transport        : ${data.lastTransport || "unknown"}`);

  // Photo counts by period
  const weekAgo = Date.now() - 7 * 86_400_000;
  const thisWeek = records.filter((r) => new Date(r.downloadedAt).getTime() > weekAgo).length;
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const thisMonth = records.filter((r) => new Date(r.downloadedAt).getTime() > monthStart.getTime()).length;
  console.log(`Photos this week      : ${thisWeek}`);
  console.log(`Photos this month     : ${thisMonth}`);

  // Failure rate
  const recentRuns = (data.runs ?? []).slice(-20);
  const failedRuns = recentRuns.filter((r) => r.outcome === "failure").length;
  const failureRate = recentRuns.length > 0 ? Math.round((failedRuns / recentRuns.length) * 100) : 0;
  console.log(`Recent failure rate   : ${failureRate}% (${failedRuns}/${recentRuns.length})`);

  const lockPath = path.join(config.stateDir, "run.lock", "owner.json");
  const lock = await fs.readFile(lockPath, "utf8").then(JSON.parse).catch(() => undefined);
  console.log(`Active lock           : ${lock ? `${lock.mode}/${lock.source} since ${lock.startedAt}` : "none"}`);

  const now = indiaTime();
  const weekday = now.weekday >= 1 && now.weekday <= 5;
  const next = !weekday || now.hour >= 21 ? "next weekday 15:00 IST" : now.hour < 15 ? "today 15:00 IST" : "today 21:00 IST";
  console.log(`Next schedule         : ${next}`);

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
