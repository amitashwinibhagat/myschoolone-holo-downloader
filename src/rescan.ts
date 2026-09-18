/**
 * Re-scan the download folder and rebuild the state index from what is on disk.
 *
 * Repairs two situations:
 * - A crash between writing an image and persisting its record leaves an
 *   orphaned file that would otherwise be re-downloaded later.
 * - The state file was moved/copied without its download folder.
 *
 * Takes the shared run lock: this is a read-modify-write of `downloads.json`,
 * and racing a live download run would clobber the records it is persisting.
 *
 * Usage: npm run rescan
 */
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { acquireRunLock } from "./run-lock.js";
import { DownloadStore } from "./store.js";
import { sha256 } from "./utils.js";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif", ".avif"]);

async function walk(dir: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && !entry.name.endsWith(".tmp")) {
      files.push(full);
    }
  }
  return files;
}

async function main(): Promise<void> {
  const lock = await acquireRunLock(config.stateDir, "manual", "manual");
  if (!lock.acquired) {
    const owner = lock.owner
      ? ` (${lock.owner.mode}/${lock.owner.source} run started ${lock.owner.startedAt})`
      : "";
    console.error(`Another downloader run owns the state${owner}. Rerun \`npm run rescan\` when it finishes.`);
    process.exitCode = 1;
    return;
  }

  try {
    const store = new DownloadStore(config.stateDir);
    await store.load();

    const files = await walk(config.downloadDir);
    console.log(`Scanning ${files.length} image file(s) under ${config.downloadDir} ...`);

    let added = 0;
    let skipped = 0;
    const rescannedAt = new Date().toISOString();
    for (const file of files) {
      const body = await fs.readFile(file);
      const hash = sha256(body);
      if (store.hasHash(hash)) {
        skipped += 1;
        continue;
      }
      // Use the rescan time as downloadedAt, NOT the file mtime: the 12-month
      // retention in store.save() would otherwise prune records for older files
      // in the same flush that writes them, forgetting their hashes.
      store.add({
        hash,
        filename: path.basename(file),
        savedPath: file,
        downloadedAt: rescannedAt,
      });
      added += 1;
      console.log(`  + ${path.basename(file)}`);
    }

    await store.flush();
    console.log(`\nDone: ${added} new record(s) added, ${skipped} already indexed.`);
  } finally {
    await lock.release();
  }
}

main().catch((error) => {
  console.error(`\nFatal: ${(error as Error).stack || (error as Error).message}`);
  process.exitCode = 1;
});
