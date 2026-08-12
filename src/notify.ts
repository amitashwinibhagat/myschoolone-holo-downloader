import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import { logWarn } from "./log.js";

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

/**
 * Send the user-facing notifications for a failed run: a dedicated LOGIN
 * REQUIRED message when the session expired, otherwise a generic FAILED
 * message plus an ACTION NEEDED escalation once the failure streak reaches 3.
 * Shared by the manual (daily.ts) and scheduled (scheduled.ts) entry points so
 * the message text cannot drift between them.
 */
export async function notifyRunFailure(
  message: string,
  outcome: "needs_login" | "failure",
  consecutiveFailures: number,
): Promise<void> {
  if (outcome === "needs_login") {
    await notify(
      "School photos — LOGIN REQUIRED",
      `The portal session is expired and the browser cannot sign in automatically.\nRun \`npm run login\` to restore it.\n${message.slice(0, 160)}`,
    );
    return;
  }
  await notify("School photos — FAILED", message.slice(0, 180));
  if (consecutiveFailures >= 3) {
    logWarn(`Failure streak reached ${consecutiveFailures} — escalating to the user.`);
    await notify(
      "School photos — ACTION NEEDED",
      "Multiple consecutive failures. Recovery steps:\n1. npm run login\n2. npm run health\n3. npm run status",
    );
  }
}

export async function pingHealthcheck(result: "success" | "fail"): Promise<void> {
  if (!config.healthcheckUrl) return;
  const suffix = result === "fail" ? "/fail" : "";
  await fetch(`${config.healthcheckUrl.replace(/\/$/, "")}${suffix}`, {
    method: "POST",
    signal: AbortSignal.timeout(20_000),
  }).catch(() => undefined);
}
