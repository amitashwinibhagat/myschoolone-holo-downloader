import fs from "node:fs/promises";
import path from "node:path";

interface DownloadRecord {
  hash: string;
  sourceUrl?: string;
  filename: string;
  savedPath: string;
  downloadedAt: string;
}

interface StoreData {
  records: DownloadRecord[];
  lastSuccessfulRunAt?: string;
}

export class DownloadStore {
  private data: StoreData = { records: [] };
  private readonly filePath: string;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, "downloads.json");
  }

  async load(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      this.data = JSON.parse(await fs.readFile(this.filePath, "utf8")) as StoreData;
      this.data.records ??= [];
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

  add(record: DownloadRecord): void {
    this.data.records.push(record);
  }

  async markSuccessfulRun(): Promise<void> {
    this.data.lastSuccessfulRunAt = new Date().toISOString();
    await this.save();
  }

  async save(): Promise<void> {
    const temp = `${this.filePath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(this.data, null, 2));
    await fs.rename(temp, this.filePath);
  }
}
