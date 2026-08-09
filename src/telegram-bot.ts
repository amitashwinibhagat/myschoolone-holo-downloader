import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { DownloadStore } from "./store.js";
import { formatStatus, helpText } from "./telegram-format.js";
import { logInfo, logWarn, logError } from "./log.js";
import { isRunLockHeld } from "./run-lock.js";
import { sleep } from "./utils.js";

const TELEGRAM_API = "https://api.telegram.org/bot";
const OFFSET_FILE = () => path.join(config.stateDir, "telegram-offset.json");
/** Absolute path to src/daily.ts, independent of the process working directory. */
const DAILY_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "daily.ts");

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
  };
}

interface GetUpdatesResponse {
  ok: boolean;
  result?: TelegramUpdate[];
  description?: string;
}

function botUrl(method: string): string {
  return `${TELEGRAM_API}${config.telegramBotToken}/${method}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function sendMessage(chatId: number, text: string): Promise<void> {
  await fetch(botUrl("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
    }),
    signal: AbortSignal.timeout(20_000),
  }).catch((error) => {
    logError(`Failed to send Telegram message to ${chatId}: ${(error as Error).message}`);
  });
}

async function getUpdates(offset: number): Promise<TelegramUpdate[]> {
  const response = await fetch(botUrl("getUpdates"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      offset,
      limit: 100,
      timeout: 30,
    }),
    // Telegram long-polling blocks up to `timeout` seconds; allow margin.
    signal: AbortSignal.timeout(90_000),
  });
  const data = (await response.json()) as GetUpdatesResponse;
  if (!data.ok) {
    throw new Error(data.description || "Telegram API returned not ok");
  }
  return data.result || [];
}

async function loadOffset(): Promise<number> {
  try {
    const parsed = JSON.parse(await fs.readFile(OFFSET_FILE(), "utf8")) as { offset?: number };
    return Number.isInteger(parsed.offset) ? (parsed.offset as number) : 0;
  } catch {
    return 0;
  }
}

async function saveOffset(offset: number): Promise<void> {
  const file = OFFSET_FILE();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ offset }, null, 2), { mode: 0o600 });
}

/**
 * Start a full download run as a child process. The bot replies immediately
 * and does not block its polling loop; daily.ts sends its own Telegram
 * notifications on completion, so a bot restart mid-run loses nothing.
 */
function spawnRun(chatId: number): void {
  const args = ["--import", "tsx", DAILY_SCRIPT, "--lookback-days", String(config.lookbackDays), "--notify-summary"];
  logInfo(`Spawning run: ${process.execPath} ${args.join(" ")}`);
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    stdio: ["ignore", "inherit", "inherit"],
    env: process.env,
  });
  child.on("error", (error) => {
    logError(`Failed to spawn run: ${error.message}`);
    void sendMessage(chatId, `Failed to start the run: ${escapeHtml(error.message)}`);
  });
}

async function handleRun(chatId: number): Promise<void> {
  if (await isRunLockHeld(config.stateDir)) {
    await sendMessage(
      chatId,
      "Busy: another downloader run is in progress. I will ignore this request; wait for it to finish.",
    );
    return;
  }

  await sendMessage(chatId, "Starting download run... you'll get the result when it finishes.");
  spawnRun(chatId);
}

async function handleStatus(chatId: number): Promise<void> {
  const store = new DownloadStore(config.stateDir);
  await store.load();
  await sendMessage(chatId, formatStatus(store));
}

async function processUpdate(update: TelegramUpdate): Promise<void> {
  const chatId = update.message?.chat.id;
  const text = update.message?.text?.trim();
  if (!chatId || !text) return;

  if (String(chatId) !== config.telegramChatId) {
    logWarn(`Ignoring update ${update.update_id} from unauthorized chat ${chatId}.`);
    return;
  }

  logInfo(`Received command from chat ${chatId}: ${text}`);
  const command = text.split(/\s+/)[0].toLowerCase();

  switch (command) {
    case "/start":
    case "/help":
      await sendMessage(chatId, helpText);
      break;
    case "/status":
      await handleStatus(chatId);
      break;
    case "/run":
      await handleRun(chatId);
      break;
    default:
      await sendMessage(chatId, "Unknown command. Send /help for available commands.");
  }
}

async function main(): Promise<void> {
  if (!config.telegramBotToken || !config.telegramChatId) {
    logError("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set to run the Telegram bot.");
    process.exitCode = 1;
    return;
  }

  // Resume from the last processed update so restarts never re-process or lose commands.
  const initialOffset = await loadOffset();
  logInfo(`Telegram bot started${initialOffset > 0 ? `, resuming from offset ${initialOffset}` : ""}.`);

  let offset = initialOffset;
  let running = true;
  let consecutiveErrors = 0;

  const stop = () => {
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (running) {
    try {
      const updates = await getUpdates(offset);
      consecutiveErrors = 0;
      for (const update of updates) {
        if (update.update_id < offset) continue;
        await processUpdate(update).catch((error) => {
          logError(`Error handling update ${update.update_id}: ${(error as Error).message}`);
        });
        // Only advance (and persist) after the update has been processed, so a
        // crash cannot silently drop it.
        offset = update.update_id + 1;
        await saveOffset(offset);
      }
    } catch (error) {
      consecutiveErrors += 1;
      const delay = Math.min(30, Math.pow(2, consecutiveErrors)); // capped exponential backoff
      logError(`Polling error (#${consecutiveErrors}): ${(error as Error).message}. Retrying in ${delay}s...`);
      await sleep(delay * 1000);
    }
  }

  logInfo("Telegram bot stopped.");
}

main().catch((error) => {
  logError(`Fatal Telegram bot error: ${(error as Error).stack || (error as Error).message}`);
  process.exitCode = 1;
});
