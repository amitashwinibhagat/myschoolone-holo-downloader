/**
 * Minimal leveled logger with size-rotated persistent output.
 *
 * Mirrors every line to the console (so launchd still captures it) and appends
 * to `stateDir/runs.log`, rotating once the file exceeds 1 MB (keeps 5 files).
 * Logging failures are swallowed so the downloader is never broken by its log.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

const MAX_LOG_BYTES = 1024 * 1024;
const KEEP_LOGS = 5;
const DEBUG_MAX_AGE_MS = 14 * 86_400_000;
const DEBUG_MAX_TOTAL_BYTES = 500 * 1024 * 1024;

export type LogLevel = "info" | "warn" | "error";

function logFilePath(): string {
  return path.join(config.stateDir, "runs.log");
}

function writeLine(level: LogLevel, message: string): void {
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}`;
  if (level === "warn") console.warn(line);
  else if (level === "error") console.error(line);
  else console.log(line);
  appendLine(line).catch(() => undefined);
}

export function log(level: LogLevel, message: string): void {
  writeLine(level, message);
}

export function logInfo(message: string): void {
  writeLine("info", message);
}

export function logWarn(message: string): void {
  writeLine("warn", message);
}

export function logError(message: string): void {
  writeLine("error", message);
}

async function appendLine(line: string): Promise<void> {
  const file = logFilePath();
  try {
    const stats = await fs.stat(file).catch(() => undefined);
    if (stats && stats.size > MAX_LOG_BYTES) await rotate(file);
    await fs.appendFile(file, `${line}\n`);
  } catch {
    /* never break the downloader over logging */
  }
}

async function rotate(file: string): Promise<void> {
  for (let i = KEEP_LOGS - 1; i >= 1; i -= 1) {
    const from = i === 1 ? file : `${file}.${i - 1}`;
    const to = `${file}.${i}`;
    await fs.rename(from, to).catch(() => undefined);
  }
}

/** Total size (bytes) of the files under a directory tree. */
async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else if (entry.isFile()) {
      const stats = await fs.stat(full).catch(() => undefined);
      if (stats) total += stats.size;
    }
  }
  return total;
}

/**
 * Remove old debug capture folders (screenshots/HTML) so `stateDir/debug`
 * stays bounded. Removes subdirectories older than `maxAgeMs` and, if the
 * total still exceeds `maxTotalBytes`, deletes the oldest until it fits.
 * Returns the number of folders removed.
 */
export async function pruneDebugDirs(maxAgeMs = DEBUG_MAX_AGE_MS, maxTotalBytes = DEBUG_MAX_TOTAL_BYTES): Promise<number> {
  const debugDir = config.debugDir;
  let entries;
  try {
    entries = await fs.readdir(debugDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  const folders: Array<{ name: string; path: string; mtime: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(debugDir, entry.name);
    const stats = await fs.stat(full).catch(() => undefined);
    if (!stats) continue;
    folders.push({ name: entry.name, path: full, mtime: stats.mtimeMs });
  }

  const now = Date.now();
  const stale = folders.filter((f) => now - f.mtime > maxAgeMs);
  for (const folder of stale) {
    await fs.rm(folder.path, { recursive: true, force: true }).catch(() => undefined);
  }
  folders.splice(0, folders.length, ...folders.filter((f) => !stale.includes(f)));

  const total = await dirSize(debugDir);
  if (total > maxTotalBytes) {
    folders.sort((a, b) => a.mtime - b.mtime);
    let freed = 0;
    for (const folder of folders) {
      if (total - freed <= maxTotalBytes) break;
      const size = await dirSize(folder.path);
      await fs.rm(folder.path, { recursive: true, force: true }).catch(() => undefined);
      freed += size;
    }
  }

  return stale.length;
}
