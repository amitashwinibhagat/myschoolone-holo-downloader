import { config } from "./config.js";
import { runDownload, type RunDownloadResult } from "./run-download.js";
import { acquireRunLock, type RunLock } from "./run-lock.js";
import { NeedsHumanLoginError } from "./portal.js";
import { DownloadStore, type RunMode, type RunRecord, type RunSource } from "./store.js";

export interface RunJobInput {
  source: RunSource;
  mode: RunMode;
  lookbackDays: number;
  stateDir?: string;
}

export interface RunJobOutput {
  ok: boolean;
  record: RunRecord;
  result?: RunDownloadResult;
  error?: Error;
  skipped: boolean;
  lockOwner?: { mode: RunMode; source: RunSource; startedAt: string };
  lock: RunLock;
  /** Current consecutive-failure streak after this run (from the store). */
  consecutiveFailures?: number;
}

export async function runJob(input: RunJobInput): Promise<RunJobOutput> {
  const startedAt = new Date().toISOString();
  const stateDir = input.stateDir ?? config.stateDir;
  const store = new DownloadStore(stateDir);
  await store.load();

  const lock = await acquireRunLock(stateDir, input.mode, input.source);

  if (!lock.acquired) {
    const finishedAt = new Date().toISOString();
    const owner = lock.owner;
    const error = owner
      ? `Locked by ${owner.mode} run from ${owner.startedAt}`
      : "Lock owner unknown";
    const record: RunRecord = {
      startedAt,
      finishedAt,
      source: input.source,
      mode: input.mode,
      transport: "browser",
      outcome: "skipped_locked",
      saved: 0,
      duplicates: 0,
      failures: 0,
      daysChecked: 0,
      error,
    };
    await store.recordRun(record);
    return {
      ok: false,
      record,
      skipped: true,
      lockOwner: owner,
      lock,
    };
  }

  try {
    const result = await runDownload(store, input.lookbackDays);
    await store.flush();
    const record: RunRecord = {
      startedAt,
      finishedAt: new Date().toISOString(),
      source: input.source,
      mode: input.mode,
      transport: result.transport,
      outcome: "success",
      saved: result.saved,
      duplicates: result.duplicates,
      failures: result.failures.length,
      daysChecked: result.daysChecked,
    };
    await store.recordRun(record);
    return { ok: true, record, result, skipped: false, lock, consecutiveFailures: store.snapshot().consecutiveFailures };
  } catch (error) {
    // Best-effort flush: the original download error must never be replaced by
    // a persistence error (e.g. ENOSPC) in this path.
    await store.flush().catch(() => undefined);
    const message = (error as Error).message;
    const loginRequired = error instanceof NeedsHumanLoginError;
    const record: RunRecord = {
      startedAt,
      finishedAt: new Date().toISOString(),
      source: input.source,
      mode: input.mode,
      transport: "browser",
      outcome: loginRequired ? "needs_login" : "failure",
      saved: 0,
      duplicates: 0,
      failures: 1,
      daysChecked: 0,
      error: message,
    };
    await store.recordRun(record);
    return { ok: false, record, error: error as Error, skipped: false, lock, consecutiveFailures: store.snapshot().consecutiveFailures };
  } finally {
    await lock.release();
  }
}
