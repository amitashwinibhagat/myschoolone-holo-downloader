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
export type RunSource = "scheduled" | "manual";
export type RunTransport = "browser" | "direct" | "browser-fallback";
export type RunOutcome = "success" | "failure" | "skipped_locked" | "off_hours";

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
  records: DownloadRecord[];
  lastSuccessfulRunAt?: string;
  lastScheduledAttemptAt?: string;
  lastNewPhotosAt?: string;
  lastReconciliationAt?: string;
  consecutiveFailures?: number;
  lastTransport?: RunTransport;
  runs?: RunRecord[];
}

const MAX_RUN_HISTORY = 300;

export class DownloadStore {
  private data: StoreData = { records: [], runs: [] };
  private readonly filePath: string;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, "downloads.json");
  }

  async load(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      this.data = JSON.parse(await fs.readFile(this.filePath, "utf8")) as StoreData;
      this.data.records ??= [];
      this.data.runs ??= [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  hasHash(hash: string): boolean {
    return this.data.records.some((record) => record.hash === hash);
  }

  lastSuccessfulRunAt(): string | undefined {
    return this.data.lastSuccessfulRunAt;
  }

  snapshot(): StoreData {
    return structuredClone(this.data);
  }

  add(record: DownloadRecord): void {
    this.data.records.push(record);
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
    } else if (record.outcome === "failure") {
      this.data.consecutiveFailures = (this.data.consecutiveFailures || 0) + 1;
    }

    await this.save();
  }

  async save(): Promise<void> {
    const temp = `${this.filePath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    await fs.rename(temp, this.filePath);
  }
}
