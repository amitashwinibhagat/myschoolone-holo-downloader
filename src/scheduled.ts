import { config } from "./config.js";
import { pingHealthcheck, notify } from "./notify.js";
import { runDownload } from "./run-download.js";
import { acquireRunLock } from "./run-lock.js";
import { DownloadStore, type RunMode, type RunRecord } from "./store.js";
import { indiaTime, sleep } from "./utils.js";
import { modeForClock } from "./schedule-window.js";

type RequestedMode = "auto" | "fast" | "reconcile";

function requestedMode(): RequestedMode {
  const index = process.argv.indexOf("--mode");
  const value = index === -1 ? "auto" : process.argv[index + 1];
  if (value === "auto" || value === "fast" || value === "reconcile") return value;
  throw new Error("--mode must be auto, fast, or reconcile.");
}

function selectAutoMode(): RunMode | undefined {
  return modeForClock(indiaTime());
}

async function acquireForMode(mode: RunMode) {
  const deadline = mode === "reconcile" ? Date.now() + 50 * 60_000 : Date.now();
  let lock = await acquireRunLock(config.stateDir, mode, "scheduled");
  while (!lock.acquired && Date.now() < deadline) {
    console.log("Reconciliation waiting for active downloader lock...");
    await sleep(2 * 60_000);
    lock = await acquireRunLock(config.stateDir, mode, "scheduled");
  }
  return lock;
}

async function record(store: DownloadStore, run: RunRecord): Promise<void> {
  await store.recordRun(run);
  console.log(`${run.mode}/${run.outcome}: ${run.saved} new, ${run.duplicates} duplicates, ${run.failures} failed.`);
}

async function main(): Promise<void> {
  const requested = requestedMode();
  const dryRun = process.argv.includes("--dry-run");
  const selected = requested === "auto" ? selectAutoMode() : requested;
  const startedAt = new Date().toISOString();
  const store = new DownloadStore(config.stateDir);
  await store.load();

  if (!selected) {
    await record(store, {
      startedAt,
      finishedAt: new Date().toISOString(),
      source: "scheduled",
      mode: "fast",
      transport: "browser",
      outcome: "off_hours",
      saved: 0,
      duplicates: 0,
      failures: 0,
      daysChecked: 0,
    });
    return;
  }

  if (dryRun) {
    console.log(`Dry run: selected ${selected} mode (${selected === "fast" ? 1 : config.lookbackDays} day lookback).`);
    return;
  }

  const lock = await acquireForMode(selected);
  if (!lock.acquired) {
    await record(store, {
      startedAt,
      finishedAt: new Date().toISOString(),
      source: "scheduled",
      mode: selected,
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
    const result = await runDownload(store, selected === "fast" ? 1 : config.lookbackDays);
    const run: RunRecord = {
      startedAt,
      finishedAt: new Date().toISOString(),
      source: "scheduled",
      mode: selected,
      transport: result.transport,
      outcome: "success",
      saved: result.saved,
      duplicates: result.duplicates,
      failures: result.failures.length,
      daysChecked: result.daysChecked,
    };
    await record(store, run);

    if (result.saved > 0) await notify("School photos", `${result.saved} new photo(s) saved (${selected} poll).`);
    if (selected === "reconcile") {
      await notify(
        "School photos — daily summary",
        `${result.saved} new, ${result.duplicates} duplicates, ${result.failures.length} failed (${result.daysChecked} day view(s), ${result.transport}).`,
      );
      await pingHealthcheck("success");
    }
  } catch (error) {
    const message = (error as Error).message;
    await record(store, {
      startedAt,
      finishedAt: new Date().toISOString(),
      source: "scheduled",
      mode: selected,
      transport: "browser",
      outcome: "failure",
      saved: 0,
      duplicates: 0,
      failures: 1,
      daysChecked: 0,
      error: message,
    });
    await notify("School photos — FAILED", `${selected} run: ${message.slice(0, 180)}`);
    if (selected === "reconcile") await pingHealthcheck("fail");
    throw error;
  } finally {
    await lock.release();
  }
}

main().catch((error) => {
  console.error(`\nFatal scheduled error: ${(error as Error).stack || (error as Error).message}`);
  process.exitCode = 1;
});
