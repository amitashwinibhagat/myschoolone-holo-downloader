import fs from "node:fs/promises";
import path from "node:path";
import type { RunMode, RunSource } from "./store.js";

interface LockMetadata {
  pid: number;
  startedAt: string;
  mode: RunMode;
  source: RunSource;
}

export interface RunLock {
  acquired: boolean;
  owner?: LockMetadata;
  release: () => Promise<void>;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readMetadata(filePath: string): Promise<LockMetadata | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as LockMetadata;
  } catch {
    return undefined;
  }
}

export async function acquireRunLock(stateDir: string, mode: RunMode, source: RunSource): Promise<RunLock> {
  const lockDir = path.join(stateDir, "run.lock");
  const metadataPath = path.join(lockDir, "owner.json");
  await fs.mkdir(stateDir, { recursive: true });

  try {
    await fs.mkdir(lockDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const owner = await readMetadata(metadataPath);
    if (owner && !processIsAlive(owner.pid)) {
      await fs.rm(lockDir, { recursive: true, force: true });
      return acquireRunLock(stateDir, mode, source);
    }
    if (!owner) {
      const stats = await fs.stat(lockDir).catch(() => undefined);
      if (stats && Date.now() - stats.mtimeMs > 30 * 60_000) {
        await fs.rm(lockDir, { recursive: true, force: true });
        return acquireRunLock(stateDir, mode, source);
      }
    }
    return { acquired: false, owner, release: async () => undefined };
  }

  const owner: LockMetadata = { pid: process.pid, startedAt: new Date().toISOString(), mode, source };
  await fs.writeFile(metadataPath, JSON.stringify(owner, null, 2), { mode: 0o600 });
  let released = false;

  return {
    acquired: true,
    owner,
    release: async () => {
      if (released) return;
      released = true;
      await fs.rm(lockDir, { recursive: true, force: true });
    },
  };
}
