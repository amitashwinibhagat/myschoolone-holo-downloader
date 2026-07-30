import { config } from "./config.js";
import { DownloadStore } from "./store.js";
import { runJob } from "./run-job.js";
import { formatStatus, helpText } from "./telegram-format.js";
import { sleep } from "./utils.js";

const TELEGRAM_API = "https://api.telegram.org/bot";

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
  }).catch(() => undefined);
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
  });
  const data = (await response.json()) as GetUpdatesResponse;
  if (!data.ok) {
    throw new Error(data.description || "Telegram API returned not ok");
  }
  return data.result || [];
}

async function handleRun(chatId: number): Promise<void> {
  await sendMessage(chatId, "Starting download run...");
  const { ok, result, skipped, lockOwner, error } = await runJob({
    source: "telegram",
    mode: "manual",
    lookbackDays: config.lookbackDays,
  });

  if (skipped) {
    await sendMessage(
      chatId,
      `Busy: another ${lockOwner?.mode ?? "downloader"} run is in progress (started ${lockOwner?.startedAt ?? "unknown"}).`,
    );
    return;
  }

  if (result && ok) {
    await sendMessage(
      chatId,
      [
        "<b>Run complete</b>",
        "",
        `${result.saved} new`,
        `${result.duplicates} duplicates`,
        `${result.failures.length} failed`,
        `${result.daysChecked} day(s) checked`,
        `Transport: ${result.transport}`,
      ].join("\n"),
    );
    return;
  }

  const message = error?.message || "Download failed without an error message.";
  await sendMessage(chatId, `<b>Run failed</b>\n\n${escapeHtml(message.slice(0, 400))}`);
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
    // Silently ignore unauthorized chats
    return;
  }

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
    console.error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set to run the Telegram bot.");
    process.exitCode = 1;
    return;
  }

  console.log("Telegram bot started. Waiting for commands...");

  let offset = 0;
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
        if (update.update_id >= offset) {
          offset = update.update_id + 1;
        }
        await processUpdate(update).catch((error) => {
          console.error(`Error handling update ${update.update_id}:`, (error as Error).message);
        });
      }
    } catch (error) {
      consecutiveErrors += 1;
      const delay = Math.min(30, Math.pow(2, consecutiveErrors)); // capped exponential backoff
      console.error(`Polling error (#${consecutiveErrors}): ${(error as Error).message}. Retrying in ${delay}s...`);
      await sleep(delay * 1000);
    }
  }

  console.log("Telegram bot stopped.");
}

main().catch((error) => {
  console.error(`Fatal Telegram bot error: ${(error as Error).stack || (error as Error).message}`);
  process.exitCode = 1;
});
