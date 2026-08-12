import { config } from "./config.js";
import { notify, notifyRunFailure } from "./notify.js";
import { runJob } from "./run-job.js";
import { logInfo, logWarn, logError, pruneDebugDirs } from "./log.js";

function lookbackFromArgs(): number {
  const index = process.argv.indexOf("--lookback-days");
  if (index === -1) return config.lookbackDays;
  const value = Number.parseInt(process.argv[index + 1] || "", 10);
  if (!Number.isInteger(value) || value < 1) throw new Error("--lookback-days must be a positive integer.");
  return value;
}

async function main(): Promise<void> {
  const lookbackDays = lookbackFromArgs();
  // The Telegram bot spawns daily.ts with --notify-summary so a successful run
  // always reports back, even when nothing new was saved.
  const notifySummary = process.argv.includes("--notify-summary");
  logInfo(`Manual run starting (lookback=${lookbackDays} days, ai=${config.aiMode}).`);

  const { record, result, skipped, lockOwner, error, consecutiveFailures } = await runJob({
    source: "manual",
    mode: "manual",
    lookbackDays,
  });

  await pruneDebugDirs().catch(() => undefined);

  if (skipped) {
    const owner = lockOwner ? ` (${lockOwner.mode} run started ${lockOwner.startedAt})` : "";
    const message = `Another downloader run owns the browser profile${owner}.`;
    logWarn(`Skipped: ${message}`);
    await notify("School photos — BUSY", message);
    return;
  }

  if (result) {
    const summary = `${result.saved} new, ${result.duplicates} duplicates, ${result.failures.length} failed (${result.daysChecked} day view(s) checked via ${result.transport}).`;
    logInfo(`Done: ${summary}`);
    for (const failure of result.failures) logWarn(`  ! ${failure}`);
    if (notifySummary) {
      await notify("School photos — run complete", summary);
    } else if (result.saved > 0) {
      await notify("School photos", `${result.saved} new photo(s) saved.`);
    }
    return;
  }

  // Failure
  const message = error?.message || "Download failed without an error message.";
  logError(`Failed: ${message}`);
  await notifyRunFailure(message, record.outcome === "needs_login" ? "needs_login" : "failure", consecutiveFailures ?? 0);
  throw error || new Error(message);
}

main().catch((error) => {
  logError(`\nFatal error: ${(error as Error).stack || (error as Error).message}`);
  process.exitCode = 1;
});
