// Prints a quick health summary: last successful run, photo counts per day.
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { dateInIndia } from "./utils.js";

interface StoreData {
  records?: { savedPath: string; downloadedAt: string }[];
  lastSuccessfulRunAt?: string;
}

const raw = await fs
  .readFile(path.join(config.stateDir, "downloads.json"), "utf8")
  .catch(() => '{"records":[]}');
const data = JSON.parse(raw) as StoreData;
const records = data.records ?? [];

const lastRun = data.lastSuccessfulRunAt;
const ranToday = lastRun ? dateInIndia(new Date(lastRun)) === dateInIndia() : false;
console.log(`Download folder : ${config.downloadDir}`);
console.log(`Total photos    : ${records.length}`);
console.log(
  `Last good run   : ${lastRun ? new Date(lastRun).toLocaleString() : "never"}${ranToday ? " (today ✓)" : ""}`,
);

const byFolder = new Map<string, number>();
for (const record of records) {
  const folder = path.basename(path.dirname(record.savedPath));
  byFolder.set(folder, (byFolder.get(folder) || 0) + 1);
}
const days = [...byFolder.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 10);
if (days.length > 0) {
  console.log("\nRecent days:");
  for (const [day, count] of days) console.log(`  ${day}  ${count} photo(s)`);
}
