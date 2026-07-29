import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { DownloadStore } from "./store.js";
import { dateInIndia, indiaTime } from "./utils.js";

const store = new DownloadStore(config.stateDir);
await store.load();
const data = store.snapshot();
const records = data.records ?? [];

const lastRun = data.lastSuccessfulRunAt;
const ranToday = lastRun ? dateInIndia(new Date(lastRun)) === dateInIndia() : false;
console.log(`Download folder       : ${config.downloadDir}`);
console.log(`State folder          : ${config.stateDir}`);
console.log(`Total photos          : ${records.length}`);
console.log(`Last good run         : ${lastRun ? new Date(lastRun).toLocaleString() : "never"}${ranToday ? " (today ✓)" : ""}`);
console.log(`Last scheduled attempt: ${data.lastScheduledAttemptAt ? new Date(data.lastScheduledAttemptAt).toLocaleString() : "never"}`);
console.log(`Last reconciliation   : ${data.lastReconciliationAt ? new Date(data.lastReconciliationAt).toLocaleString() : "never"}`);
console.log(`Last new photos       : ${data.lastNewPhotosAt ? new Date(data.lastNewPhotosAt).toLocaleString() : "never"}`);
console.log(`Failure streak        : ${data.consecutiveFailures || 0}`);

const lockPath = path.join(config.stateDir, "run.lock", "owner.json");
const lock = await fs.readFile(lockPath, "utf8").then(JSON.parse).catch(() => undefined);
console.log(`Active lock           : ${lock ? `${lock.mode}/${lock.source} since ${lock.startedAt}` : "none"}`);

const now = indiaTime();
const weekday = now.weekday >= 1 && now.weekday <= 5;
const next = !weekday || now.hour >= 21 ? "next weekday 13:00 IST" : now.hour < 13 ? "today 13:00 IST" : "next 10-minute interval IST";
console.log(`Next schedule         : ${next}`);

const recentRuns = (data.runs ?? []).slice(-10).reverse();
if (recentRuns.length > 0) {
  console.log("\nRecent runs:");
  for (const run of recentRuns) {
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
