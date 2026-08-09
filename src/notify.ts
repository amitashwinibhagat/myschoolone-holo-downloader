import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";

const exec = promisify(execFile);

export async function notify(title: string, message: string): Promise<void> {
  if (config.telegramBotToken && config.telegramChatId) {
    await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: config.telegramChatId, text: `${title}\n${message}` }),
      signal: AbortSignal.timeout(20_000),
    }).catch(() => undefined);
    return;
  }

  const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
  await exec("osascript", ["-e", script]).catch(() => undefined);
}

export async function pingHealthcheck(result: "success" | "fail"): Promise<void> {
  if (!config.healthcheckUrl) return;
  const suffix = result === "fail" ? "/fail" : "";
  await fetch(`${config.healthcheckUrl.replace(/\/$/, "")}${suffix}`, {
    method: "POST",
    signal: AbortSignal.timeout(20_000),
  }).catch(() => undefined);
}
