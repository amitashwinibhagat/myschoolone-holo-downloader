import { config } from "./config.js";
import { pingHealthcheck, notify, notifyRunFailure } from "./notify.js";
import { runJob } from "./run-job.js";
import { runHealthCheck } from "./health.js";
import { logInfo, logWarn, logError, pruneDebugDirs } from "./log.js";
import { indiaTime } from "./utils.js";
import { decideDue, lookbackForMode, nextRunInfo } from "./schedule-window.js";
import { DownloadStore } from "./store.js";

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");
  const clock = indiaTime();

  // Base the decision on staleness, not on the clock hour. GitHub's cron drifts
  // by hours under load, and the old exact-hour window silently discarded those
  // runs (12 of the last 25 exited here without touching the portal).
  const store = new DownloadStore(config.stateDir);
  await store.load();
  const decision = decideDue(clock, store.lastSuccessfulRunAt(), Date.now(), { force });

  if (!decision.run) {
    const detail =
      decision.reason === "fresh"
        ? "index is already fresh"
        : decision.reason === "weekend"
          ? "weekend"
          : `outside the ${clock.hour}:00 IST run window`;
    logInfo(`Not due (${detail}) — skipping. Use --force to override.`);
    return;
  }

  const effectiveMode = decision.mode;
  const lookbackDays = lookbackForMode(effectiveMode, config.lookbackDays);
  const ageLabel =
    decision.ageMs === undefined ? "never ran successfully" : `${Math.round(decision.ageMs / 3_600_000)}h since last success`;

  if (dryRun) {
    logInfo(`Dry run: ${ageLabel}, mode=${effectiveMode}, ${lookbackDays}-day lookback.`);
    return;
  }

  logInfo(`Due (${ageLabel}) — running ${effectiveMode} with a ${lookbackDays}-day lookback.`);

  const { record, result, skipped, lockOwner, error, consecutiveFailures, hint } = await runJob({
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
    // lock is held). Only runs when the sweep was a full reconcile — a health
    // check launches a second browser, which is wasted after a 1-day fast poll.
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
  if (hint) logError(hint);
  await notifyRunFailure(message, record.outcome === "needs_login" ? "needs_login" : "failure", consecutiveFailures ?? 0, hint);
  await pingHealthcheck("fail");
  throw error || new Error(message);
}

main().catch((error) => {
  logError(`\nFatal scheduled error: ${(error as Error).stack || (error as Error).message}`);
  process.exitCode = 1;
});
