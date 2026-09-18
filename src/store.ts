import fs from "node:fs/promises";
import path from "node:path";

export interface DownloadRecord {
  hash: string;
  sourceUrl?: string;
  filename: string;
  savedPath: string;
  downloadedAt: string;
}

export type RunMode = "fast" | "reconcile" | "manual";
export type RunSource = "scheduled" | "manual" | "telegram";
export type RunTransport = "browser" | "direct" | "browser-fallback";
export type RunOutcome = "success" | "failure" | "skipped_locked" | "needs_login";

export interface RunRecord {
  startedAt: string;
  finishedAt: string;
  source: RunSource;
  mode: RunMode;
  transport: RunTransport;
  outcome: RunOutcome;
  saved: number;
  duplicates: number;
  failures: number;
  daysChecked: number;
  error?: string;
}

export interface StoreData {
  schemaVersion?: number;
  records: DownloadRecord[];
  lastSuccessfulRunAt?: string;
  lastScheduledAttemptAt?: string;
  lastNewPhotosAt?: string;
  lastReconciliationAt?: string;
  consecutiveFailures?: number;
  lastTransport?: RunTransport;
  runs?: RunRecord[];
}

const SCHEMA_VERSION = 1;
const MAX_RUN_HISTORY = 300;
/** Keep at most 12 months of download history. */
const RECORD_RETENTION_MS = 12 * 30 * 86_400_000;
/** Hard cap on stored download records (bounds downloads.json size). */
const MAX_RECORDS = 10_000;

export class DownloadStore {
  private data: StoreData = { records: [], runs: [] };
  private readonly filePath: string;
  private dirty = false;
  /** O(1) duplicate lookup, kept in sync with data.records. */
  private hashes = new Set<string>();

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, "downloads.json");
  }

  /**
   * Move an unreadable state file aside (never delete user data) and reset to
   * an empty store so every command keeps working; `npm run rescan` rebuilds
   * the hash index from the download folder.
   */
  private async quarantine(reason: string): Promise<void> {
    const backup = `${this.filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await fs.rename(this.filePath, backup).catch(() => undefined);
    console.warn(`Download index was ${reason} — moved to ${backup} and starting fresh.`);
    this.data = { records: [], runs: [] };
    this.hashes = new Set();
  }

  async load(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      // A crash or full disk mid-write can leave half-written JSON behind.
      if (error instanceof SyntaxError) return this.quarantine("corrupt");
      throw error;
    }

    // Valid JSON can still be the wrong shape (hand-edited, truncated to a
    // bare `{}`, or written by another tool). Treat that like corrupt state
    // instead of letting `records.map` throw a TypeError that would break
    // every command (status, daily, scheduled, Telegram /status).
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return this.quarantine("not a store object");
    }
    const candidate = parsed as StoreData;
    if (candidate.records !== undefined && !Array.isArray(candidate.records)) {
      return this.quarantine("missing a records array");
    }
    if (candidate.runs !== undefined && !Array.isArray(candidate.runs)) {
      return this.quarantine("missing a runs array");
    }

    this.data = candidate;
    // Legacy files have no schemaVersion; keep them working as-is.
    this.data.records ??= [];
    this.data.runs ??= [];
    this.hashes = new Set(this.data.records.map((r) => r.hash));
  }

  hasHash(hash: string): boolean {
    return this.hashes.has(hash);
  }

  lastSuccessfulRunAt(): string | undefined {
    return this.data.lastSuccessfulRunAt;
  }

  snapshot(): StoreData {
    return structuredClone(this.data);
  }

  /** Queue a record for persistence. No disk write until `flush()`/`save()`. */
  add(record: DownloadRecord): void {
    this.data.records.push(record);
    this.hashes.add(record.hash);
    this.dirty = true;
  }

  async markSuccessfulRun(): Promise<void> {
    this.data.lastSuccessfulRunAt = new Date().toISOString();
    await this.save();
  }

  async recordRun(record: RunRecord): Promise<void> {
    this.data.runs ??= [];
    this.data.runs.push(record);
    if (this.data.runs.length > MAX_RUN_HISTORY) this.data.runs.splice(0, this.data.runs.length - MAX_RUN_HISTORY);

    if (record.source === "scheduled") this.data.lastScheduledAttemptAt = record.startedAt;
    this.data.lastTransport = record.transport;

    if (record.outcome === "success") {
      this.data.lastSuccessfulRunAt = record.finishedAt;
      this.data.consecutiveFailures = 0;
      if (record.saved > 0) this.data.lastNewPhotosAt = record.finishedAt;
      if (record.mode === "reconcile") this.data.lastReconciliationAt = record.finishedAt;
    } else if (record.outcome === "failure" || record.outcome === "needs_login") {
      this.data.consecutiveFailures = (this.data.consecutiveFailures || 0) + 1;
    }

    await this.save();
  }

  /** Write queued records (and any other pending changes) to disk. */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    await this.save();
  }

  async save(): Promise<void> {
    this.pruneRecords();
    this.data.schemaVersion = SCHEMA_VERSION;
    const temp = `${this.filePath}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      await fs.rename(temp, this.filePath);
    } catch (error) {
      // Never leave a half-written .tmp behind to confuse the next load.
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
    this.dirty = false;
  }

  /** Drop very old records and enforce a hard cap so downloads.json stays bounded. */
  private pruneRecords(): void {
    const cutoff = Date.now() - RECORD_RETENTION_MS;
    if (this.data.records.length > MAX_RECORDS || this.data.records.some((r) => Date.parse(r.downloadedAt) < cutoff)) {
      this.data.records = this.data.records
        .filter((r) => Date.parse(r.downloadedAt) >= cutoff)
        .slice(-MAX_RECORDS);
      this.hashes = new Set(this.data.records.map((r) => r.hash));
    }
  }
}
