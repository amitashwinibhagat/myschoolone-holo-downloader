import { config } from "./config.js";
import { notify } from "./notify.js";
import { runDownload } from "./run-download.js";
import { acquireRunLock } from "./run-lock.js";
import { DownloadStore, type RunRecord } from "./store.js";

function lookbackFromArgs(): number {
  const index = process.argv.indexOf("--lookback-days");
  if (index === -1) return config.lookbackDays;
  const value = Number.parseInt(process.argv[index + 1] || "", 10);
  if (!Number.isInteger(value) || value < 1) throw new Error("--lookback-days must be a positive integer.");
  return value;
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const store = new DownloadStore(config.stateDir);
  await store.load();
  const lock = await acquireRunLock(config.stateDir, "manual", "manual");

  if (!lock.acquired) {
    const owner = lock.owner ? ` (${lock.owner.mode} run started ${lock.owner.startedAt})` : "";
    console.log(`Skipped: another downloader run owns the browser profile${owner}.`);
    const record: RunRecord = {
      startedAt,
      finishedAt: new Date().toISOString(),
      source: "manual",
      mode: "manual",
      transport: "browser",
      outcome: "skipped_locked",
      saved: 0,
      duplicates: 0,
      failures: 0,
      daysChecked: 0,
    };
    await store.recordRun(record);
    return;
  }

  try {
    const result = await runDownload(store, lookbackFromArgs());
    const record: RunRecord = {
      startedAt,
      finishedAt: new Date().toISOString(),
      source: "manual",
      mode: "manual",
      transport: result.transport,
      outcome: "success",
      saved: result.saved,
      duplicates: result.duplicates,
      failures: result.failures.length,
      daysChecked: result.daysChecked,
    };
    await store.recordRun(record);
    const summary = `${result.saved} new, ${result.duplicates} duplicates, ${result.failures.length} failed (${result.daysChecked} day view(s) checked).`;
    console.log(`\nDone: ${summary}`);
    for (const failure of result.failures) console.log(`  ! ${failure}`);
    if (result.saved > 0) await notify("School photos", `${result.saved} new photo(s) saved.`);
  } catch (error) {
    const message = (error as Error).message;
    await store.recordRun({
      startedAt,
      finishedAt: new Date().toISOString(),
      source: "manual",
      mode: "manual",
      transport: "browser",
      outcome: "failure",
      saved: 0,
      duplicates: 0,
      failures: 1,
      daysChecked: 0,
      error: message,
    });
    await notify("School photos — FAILED", message.slice(0, 180));
    throw error;
  } finally {
    await lock.release();
  }
}

main().catch((error) => {
  console.error(`\nFatal error: ${(error as Error).stack || (error as Error).message}`);
  process.exitCode = 1;
});
