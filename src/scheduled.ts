import { config } from "./config.js";
import { pingHealthcheck, notify } from "./notify.js";
import { runDownload } from "./run-download.js";
import { acquireRunLock } from "./run-lock.js";
import { DownloadStore, type RunRecord } from "./store.js";
import { indiaTime } from "./utils.js";

function isWeekday(): boolean {
  return indiaTime().weekday >= 1 && indiaTime().weekday <= 5;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const startedAt = new Date().toISOString();
  const store = new DownloadStore(config.stateDir);
  await store.load();

  if (!isWeekday()) {
    console.log("Weekend — skipping.");
    return;
  }

  if (dryRun) {
    console.log(`Dry run: weekday, ${config.lookbackDays}-day lookback.`);
    return;
  }

  const lock = await acquireRunLock(config.stateDir, "reconcile", "scheduled");
  if (!lock.acquired) {
    console.log(`Locked by ${lock.owner?.mode} run from ${lock.owner?.startedAt}. Skipping.`);
    await store.recordRun({
      startedAt,
      finishedAt: new Date().toISOString(),
      source: "scheduled",
      mode: "reconcile",
      transport: "browser",
      outcome: "skipped_locked",
      saved: 0,
      duplicates: 0,
      failures: 0,
      daysChecked: 0,
      error: lock.owner ? `Locked by ${lock.owner.mode} run from ${lock.owner.startedAt}` : "Lock owner unknown",
    });
    return;
  }

  try {
    const result = await runDownload(store, config.lookbackDays);
    const run: RunRecord = {
      startedAt,
      finishedAt: new Date().toISOString(),
      source: "scheduled",
      mode: "reconcile",
      transport: result.transport,
      outcome: "success",
      saved: result.saved,
      duplicates: result.duplicates,
      failures: result.failures.length,
      daysChecked: result.daysChecked,
    };
    await store.recordRun(run);
    console.log(`${run.outcome}: ${result.saved} new, ${result.duplicates} duplicates, ${result.failures.length} failed.`);

    if (result.saved > 0) await notify("School photos", `${result.saved} new photo(s) saved.`);
    await notify(
      "School photos — daily summary",
      `${result.saved} new, ${result.duplicates} duplicates, ${result.failures.length} failed (${result.daysChecked} day view(s), ${result.transport}).`,
    );
    await pingHealthcheck("success");
  } catch (error) {
    const message = (error as Error).message;
    await store.recordRun({
      startedAt,
      finishedAt: new Date().toISOString(),
      source: "scheduled",
      mode: "reconcile",
      transport: "browser",
      outcome: "failure",
      saved: 0,
      duplicates: 0,
      failures: 1,
      daysChecked: 0,
      error: message,
    });
    console.error(`Failed: ${message}`);
    await notify("School photos — FAILED", message.slice(0, 180));
    await pingHealthcheck("fail");
    throw error;
  } finally {
    await lock.release();
  }
}

main().catch((error) => {
  console.error(`\nFatal scheduled error: ${(error as Error).stack || (error as Error).message}`);
  process.exitCode = 1;
});
