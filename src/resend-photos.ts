/**
 * resend-photos.ts — send photos from the last (or a specific) daily download
 * folder to the configured Telegram chat.
 *
 * Usage:
 *   npm run resend-photos                 # last downloaded date
 *   npm run resend-photos -- 2026-09-07   # specific ISO date
 *
 * This is a best-effort delivery script; it never modifies state or the store.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { sendTelegramPhotos } from "./notify.js";
import { logInfo, logWarn, logError } from "./log.js";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic"]);

/**
 * Return the ISO date argument from argv, or undefined (meaning: use the most
 * recent date subfolder).
 */
function parseDateArg(): string | undefined {
  const arg = process.argv[2];
  if (!arg) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
    throw new Error(`Invalid date argument "${arg}". Expected YYYY-MM-DD.`);
  }
  return arg;
}

/** Find the most recent YYYY-MM-DD subfolder under downloadDir. */
async function latestDateFolder(downloadDir: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await fs.readdir(downloadDir);
  } catch {
    return undefined;
  }

  const dateFolders = entries
    .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
    .sort()
    .reverse();

  return dateFolders[0];
}

/** Collect image files (non-recursively) from a directory. */
async function collectImages(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  return entries
    .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .map((name) => path.join(dir, name))
    .sort(); // alphabetical = chronological (filenames contain a hash prefix)
}

async function main(): Promise<void> {
  if (!config.telegramBotToken || !config.telegramChatId) {
    logError("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set in .env.");
    process.exitCode = 1;
    return;
  }

  const dateArg = parseDateArg();
  const dateLabel = dateArg ?? (await latestDateFolder(config.downloadDir));

  if (!dateLabel) {
    logWarn(`No date subfolders found under ${config.downloadDir}. Nothing to send.`);
    return;
  }

  const folder = path.join(config.downloadDir, dateLabel);
  const images = await collectImages(folder);

  if (images.length === 0) {
    logWarn(`No image files found in ${folder}. Nothing to send.`);
    return;
  }

  logInfo(`Sending ${images.length} photo(s) from ${dateLabel} to Telegram...`);

  await sendTelegramPhotos(images, `📸 ${images.length} photo(s) from ${dateLabel}`);

  logInfo("Done.");
}

main().catch((error) => {
  logError(`Fatal: ${(error as Error).message}`);
  process.exitCode = 1;
});
