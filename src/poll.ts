import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import { sleep } from "./utils.js";

const exec = promisify(execFile);

const POLL_INTERVAL_MS = 10 * 60 * 1_000;
const START_HOUR = 13;
const END_HOUR = 21;

function istNow(): Date {
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  return ist;
}

function isWeekday(d: Date): boolean {
  const day = d.getDay();
  return day >= 1 && day <= 5;
}

function withinWindow(d: Date): boolean {
  return d.getHours() >= START_HOUR && d.getHours() < END_HOUR;
}

async function sendTelegram(title: string, message: string): Promise<void> {
  if (!config.telegramBotToken || !config.telegramChatId) return;
  await fetch(
    `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: config.telegramChatId, text: `${title}\n${message}` }),
    },
  ).catch(() => undefined);
}

async function runDaily(): Promise<string> {
  const tsx = path.resolve("node_modules/tsx/dist/cli.mjs");
  const daily = path.resolve("src/daily.ts");
  try {
    const { stdout, stderr } = await exec(process.execPath, [tsx, daily], {
      cwd: process.cwd(),
      timeout: 10 * 60_000,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    const output = (stdout + stderr).trim();
    const doneLine = output.split("\n").find((l) => l.startsWith("Done:")) || "completed";
    return doneLine;
  } catch (error) {
    return `FAILED: ${(error as Error).message.slice(0, 200)}`;
  }
}

async function main(): Promise<void> {
  console.log(`Poll mode: every 10 min, ${START_HOUR}:00–${END_HOUR}:00 IST, weekdays only`);

  while (true) {
    const now = istNow();
    const hour = now.getHours();
    const day = now.getDay();

    if (!isWeekday(now) || !withinWindow(now)) {
      const nextCheck = new Date(now);
      if (!isWeekday(now)) {
        const daysUntilMon = (8 - day) % 7 || 7;
        nextCheck.setDate(nextCheck.getDate() + daysUntilMon);
        nextCheck.setHours(START_HOUR, 0, 0, 0);
      } else if (hour < START_HOUR) {
        nextCheck.setHours(START_HOUR, 0, 0, 0);
      } else {
        nextCheck.setDate(nextCheck.getDate() + 1);
        nextCheck.setHours(START_HOUR, 0, 0, 0);
      }
      const waitMs = nextCheck.getTime() - now.getTime();
      console.log(
        `Outside window (${now.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}). ` +
          `Next check at ${nextCheck.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`,
      );
      await sleep(Math.min(waitMs, 60 * 60_000));
      continue;
    }

    console.log(`\n[${now.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}] Running daily...`);
    const result = await runDaily();
    console.log(`Result: ${result}`);
    await sendTelegram("School photos poll", result);

    const msUntilEnd = END_HOUR * 3_600_000 - (hour * 3_600_000 + now.getMinutes() * 60_000 + now.getSeconds() * 1_000);
    if (msUntilEnd <= POLL_INTERVAL_MS) {
      console.log(`End of window. Sleeping until tomorrow ${START_HOUR}:00.`);
      await sleep(msUntilEnd + 60_000);
      continue;
    }

    console.log(`Next poll in 10 minutes.`);
    await sleep(POLL_INTERVAL_MS);
  }
}

main().catch((error) => {
  console.error(`\nFatal: ${(error as Error).stack || (error as Error).message}`);
  process.exitCode = 1;
});
