import { config } from "./config.js";
import { pingHealthcheck, notify, notifyRunFailure } from "./notify.js";
import { runJob } from "./run-job.js";
import { runHealthCheck } from "./health.js";
import { logInfo, logWarn, logError, pruneDebugDirs } from "./log.js";
import { indiaTime } from "./utils.js";
import { modeForClock, nextRunInfo } from "./schedule-window.js";

function isWeekday(): boolean {
  return indiaTime().weekday >= 1 && indiaTime().weekday <= 5;
}

/** Determine lookback days based on the schedule mode. */
function lookbackForMode(mode: "fast" | "reconcile"): number {
  if (mode === "fast") return 1; // Fast poll: only check today
  return config.lookbackDays;     // Reconcile: full lookback window
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");
  const clock = indiaTime();

  if (!isWeekday()) {
    logInfo("Weekend — skipping.");
    return;
  }

  // Use the schedule-window to determine the run mode
  const mode = modeForClock(clock);
  if (!mode && !force) {
    logInfo(`Outside schedule window (hour=${clock.hour}) — skipping. Use --force to override.`);
    return;
  }

  const effectiveMode: "fast" | "reconcile" = mode || "reconcile";
  const lookbackDays = lookbackForMode(effectiveMode);

  if (dryRun) {
    logInfo(`Dry run: weekday, mode=${effectiveMode}, ${lookbackDays}-day lookback, ai=${config.aiMode}.`);
    return;
  }

  const { record, result, skipped, lockOwner, error, consecutiveFailures } = await runJob({
    source: "scheduled",
    mode: effectiveMode,
    lookbackDays,
  });

  await pruneDebugDirs().catch(() => undefined);

  if (skipped) {
    logWarn(`Locked by ${lockOwner?.mode} run from ${lockOwner?.startedAt}. Skipping.`);
    return;
  }

  if (result) {
    logInfo(`${record.outcome}: ${result.saved} new, ${result.duplicates} duplicates, ${result.failures.length} failed.`);

    // Richer notification with transport and next-run hint
    const notifLines = [
      `${result.saved} new, ${result.duplicates} duplicates, ${result.failures.length} failed`,
      `${result.daysChecked} day(s) via ${result.transport} (${effectiveMode} mode)`,
      `Next run: ${nextRunInfo(clock)}`,
    ];
    if (result.saved > 0) await notify("School photos", `${result.saved} new photo(s) saved.`);
    await notify("School photos — daily summary", notifLines.join("\n"));
    await pingHealthcheck("success");

    // Best-effort portal fingerprint check (skipped silently when the browser
    // lock is held). Only runs on the 9PM reconcile to avoid a second browser
    // launch after every 3PM fast run. Confirmed changes are notified by
    // runHealthCheck.
    if (effectiveMode === "reconcile") {
      try {
        const health = await runHealthCheck();
        if (health.changed) logWarn(`Health check: ${health.message}`);
        else logInfo(`Health check: ${health.message}`);
      } catch (error) {
        logWarn(`Health check failed: ${(error as Error).message}`);
      }
    }
    return;
  }

  // Failure
  const message = error?.message || "Download failed without an error message.";
  logError(`Failed: ${message}`);
  await notifyRunFailure(message, record.outcome === "needs_login" ? "needs_login" : "failure", consecutiveFailures ?? 0);
  await pingHealthcheck("fail");
  throw error || new Error(message);
}

main().catch((error) => {
  logError(`\nFatal scheduled error: ${(error as Error).stack || (error as Error).message}`);
  process.exitCode = 1;
});
