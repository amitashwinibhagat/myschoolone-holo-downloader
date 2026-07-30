import { config } from "./config.js";
import { pingHealthcheck, notify } from "./notify.js";
import { runJob } from "./run-job.js";
import { indiaTime } from "./utils.js";
import { modeForClock } from "./schedule-window.js";

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
    console.log("Weekend — skipping.");
    return;
  }

  // Use the schedule-window to determine the run mode
  const mode = modeForClock(clock);
  if (!mode && !force) {
    console.log(`Outside schedule window (hour=${clock.hour}) — skipping. Use --force to override.`);
    return;
  }

  const effectiveMode: "fast" | "reconcile" = mode || "reconcile";
  const lookbackDays = lookbackForMode(effectiveMode);

  if (dryRun) {
    console.log(`Dry run: weekday, mode=${effectiveMode}, ${lookbackDays}-day lookback, ai=${config.aiMode}.`);
    return;
  }

  const { record, result, skipped, lockOwner, error } = await runJob({
    source: "scheduled",
    mode: effectiveMode,
    lookbackDays,
  });

  if (skipped) {
    console.log(`Locked by ${lockOwner?.mode} run from ${lockOwner?.startedAt}. Skipping.`);
    return;
  }

  if (result) {
    console.log(`${record.outcome}: ${result.saved} new, ${result.duplicates} duplicates, ${result.failures.length} failed.`);

    // Richer notification with transport and next-run hint
    const nextRun = isWeekday() && clock.hour < 15
      ? "today 3PM"
      : isWeekday() && clock.hour < 21
        ? "today 9PM"
        : "next weekday 3PM";
    const notifLines = [
      `${result.saved} new, ${result.duplicates} duplicates, ${result.failures.length} failed`,
      `${result.daysChecked} day(s) via ${result.transport} (${effectiveMode} mode)`,
      `Next run: ${nextRun} IST`,
    ];
    if (result.saved > 0) await notify("School photos", `${result.saved} new photo(s) saved.`);
    await notify("School photos — daily summary", notifLines.join("\n"));
    await pingHealthcheck("success");
    return;
  }

  // Failure
  const message = error?.message || "Download failed without an error message.";
  console.error(`Failed: ${message}`);
  await notify("School photos — FAILED", message.slice(0, 180));
  await pingHealthcheck("fail");
  throw error || new Error(message);
}

main().catch((error) => {
  console.error(`\nFatal scheduled error: ${(error as Error).stack || (error as Error).message}`);
  process.exitCode = 1;
});
