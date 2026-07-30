import { config } from "./config.js";
import { notify } from "./notify.js";
import { runJob } from "./run-job.js";

function lookbackFromArgs(): number {
  const index = process.argv.indexOf("--lookback-days");
  if (index === -1) return config.lookbackDays;
  const value = Number.parseInt(process.argv[index + 1] || "", 10);
  if (!Number.isInteger(value) || value < 1) throw new Error("--lookback-days must be a positive integer.");
  return value;
}

async function main(): Promise<void> {
  const { record, result, skipped, lockOwner, error } = await runJob({
    source: "manual",
    mode: "manual",
    lookbackDays: lookbackFromArgs(),
  });

  if (skipped) {
    const owner = lockOwner ? ` (${lockOwner.mode} run started ${lockOwner.startedAt})` : "";
    console.log(`Skipped: another downloader run owns the browser profile${owner}.`);
    return;
  }

  if (result) {
    const summary = `${result.saved} new, ${result.duplicates} duplicates, ${result.failures.length} failed (${result.daysChecked} day view(s) checked).`;
    console.log(`\nDone: ${summary}`);
    for (const failure of result.failures) console.log(`  ! ${failure}`);
    if (result.saved > 0) await notify("School photos", `${result.saved} new photo(s) saved.`);
    return;
  }

  // Failure
  const message = error?.message || "Download failed without an error message.";
  console.error(`\nFailed: ${message}`);
  await notify("School photos — FAILED", message.slice(0, 180));
  throw error || new Error(message);
}

main().catch((error) => {
  console.error(`\nFatal error: ${(error as Error).stack || (error as Error).message}`);
  process.exitCode = 1;
});
