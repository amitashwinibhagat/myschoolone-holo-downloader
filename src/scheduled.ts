import { config } from "./config.js";
import { pingHealthcheck, notify } from "./notify.js";
import { runDownload } from "./run-download.js";
import { acquireRunLock } from "./run-lock.js";
import { DownloadStore, type RunRecord, type RunMode } from "./store.js";
import { indiaTime } from "./utils.js";
import { modeForClock } from "./schedule-window.js";

function isWeekday(): boolean {
  return indiaTime().weekday >= 1 && indiaTime().weekday <= 5;
}

/** Determine lookback days based on the schedule mode. */
function lookbackForMode(mode: RunMode): number {
  if (mode === "fast") return 1;   // Fast poll: only check today
  return config.lookbackDays;       // Reconcile: full lookback window
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");
  const startedAt = new Date().toISOString();
  const store = new DownloadStore(config.stateDir);
  await store.load();

  if (!isWeekday()) {
    console.log("Weekend — skipping.");
    return;
  }

  // Use the schedule-window to determine the run mode
  const clock = indiaTime();
  const mode = modeForClock(clock);
  if (!mode && !force) {
    console.log(`Outside schedule window (hour=${clock.hour}) — skipping. Use --force to override.`);
    return;
  }

  const effectiveMode: RunMode = mode || "reconcile";
  const lookbackDays = lookbackForMode(effectiveMode);

  if (dryRun) {
    console.log(`Dry run: weekday, mode=${effectiveMode}, ${lookbackDays}-day lookback, ai=${config.aiMode}.`);
    return;
  }

  const lock = await acquireRunLock(config.stateDir, effectiveMode, "scheduled");
  if (!lock.acquired) {
    console.log(`Locked by ${lock.owner?.mode} run from ${lock.owner?.startedAt}. Skipping.`);
    await store.recordRun({
      startedAt,
      finishedAt: new Date().toISOString(),
      source: "scheduled",
      mode: effectiveMode,
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
    const result = await runDownload(store, lookbackDays);
    const run: RunRecord = {
      startedAt,
      finishedAt: new Date().toISOString(),
      source: "scheduled",
      mode: effectiveMode,
      transport: result.transport,
      outcome: "success",
      saved: result.saved,
      duplicates: result.duplicates,
      failures: result.failures.length,
      daysChecked: result.daysChecked,
    };
    await store.recordRun(run);
    console.log(`${run.outcome}: ${result.saved} new, ${result.duplicates} duplicates, ${result.failures.length} failed.`);

    // Richer notification with transport and next-run hint
    const nextRun = isWeekday() && clock.hour < 15 ? "today 3PM" : isWeekday() && clock.hour < 21 ? "today 9PM" : "next weekday 3PM";
    const notifLines = [
      `${result.saved} new, ${result.duplicates} duplicates, ${result.failures.length} failed`,
      `${result.daysChecked} day(s) via ${result.transport} (${effectiveMode} mode)`,
      `Next run: ${nextRun} IST`,
    ];
    if (result.saved > 0) await notify("School photos", `${result.saved} new photo(s) saved.`);
    await notify("School photos — daily summary", notifLines.join("\n"));
    await pingHealthcheck("success");
  } catch (error) {
    const message = (error as Error).message;
    await store.recordRun({
      startedAt,
      finishedAt: new Date().toISOString(),
      source: "scheduled",
      mode: effectiveMode,
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
