import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import { logWarn } from "./log.js";

const exec = promisify(execFile);

export async function notify(title: string, message: string): Promise<void> {
  if (config.telegramBotToken && config.telegramChatId) {
    // Best-effort: a dead token or rate limit must never break a run, but it
    // must not fail silently either — otherwise the user believes alerts work
    // while none arrive.
    try {
      const response = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: config.telegramChatId, text: `${title}\n${message}` }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        logWarn(`Telegram notification failed: HTTP ${response.status} for "${title}".`);
      }
    } catch (error) {
      logWarn(`Telegram notification failed for "${title}": ${(error as Error).message}`);
    }
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
 *
 * `hint` (from runJob) is prepended so the next step survives the
 * notification length cap even when the raw error is long.
 */
export async function notifyRunFailure(
  message: string,
  outcome: "needs_login" | "failure",
  consecutiveFailures: number,
  hint?: string,
): Promise<void> {
  if (outcome === "needs_login") {
    await notify(
      "School photos — LOGIN REQUIRED",
      `The portal session is expired and the browser cannot sign in automatically.\nRun \`npm run login\` to restore it.\n${message.slice(0, 160)}`,
    );
    return;
  }
  const text = hint ? `${hint}\n${message}` : message;
  await notify("School photos — FAILED", text.slice(0, 180));
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

/**
 * Send downloaded photos to the Telegram chat as a photo album (sendMediaGroup)
 * or single photo (sendPhoto).
 *
 * Automatically batches photos into chunks of up to 10 (Telegram's maximum per
 * media group) and caps total photos sent per run at config.telegramMaxPhotosPerRun
 * to avoid chat flooding. Any failure is logged as a warning and never throws.
 */
export async function sendTelegramPhotos(filePaths: string[], caption?: string): Promise<void> {
  if (!config.telegramBotToken || !config.telegramChatId || !config.telegramSendPhotos) {
    return;
  }
  if (filePaths.length === 0) return;

  const maxPhotos = config.telegramMaxPhotosPerRun;
  const toSend = filePaths.slice(0, maxPhotos);
  const remaining = filePaths.length - toSend.length;

  let effectiveCaption = caption;
  if (remaining > 0) {
    const extraNote = `(+${remaining} more photo${remaining > 1 ? "s" : ""} saved to iCloud)`;
    effectiveCaption = effectiveCaption ? `${effectiveCaption}\n${extraNote}` : extraNote;
  }

  // Telegram allows at most 10 items in a single sendMediaGroup
  const BATCH_SIZE = 10;
  for (let offset = 0; offset < toSend.length; offset += BATCH_SIZE) {
    const batch = toSend.slice(offset, offset + BATCH_SIZE);
    const batchCaption = offset === 0 ? effectiveCaption : undefined;

    try {
      if (batch.length === 1) {
        const form = new FormData();
        form.append("chat_id", config.telegramChatId);
        const buffer = await fs.readFile(batch[0]);
        form.append("photo", new Blob([buffer]), path.basename(batch[0]));
        if (batchCaption) form.append("caption", batchCaption);

        const response = await fetch(
          `https://api.telegram.org/bot${config.telegramBotToken}/sendPhoto`,
          {
            method: "POST",
            body: form,
            signal: AbortSignal.timeout(30_000),
          },
        );
        if (!response.ok) {
          logWarn(`Telegram photo send failed: HTTP ${response.status}.`);
        }
      } else {
        const form = new FormData();
        form.append("chat_id", config.telegramChatId);
        const media: Array<{ type: string; media: string; caption?: string }> = [];

        for (let i = 0; i < batch.length; i += 1) {
          const attachName = `photo${i}`;
          const buffer = await fs.readFile(batch[i]);
          form.append(attachName, new Blob([buffer]), path.basename(batch[i]));
          media.push({
            type: "photo",
            media: `attach://${attachName}`,
            ...(i === 0 && batchCaption ? { caption: batchCaption } : {}),
          });
        }

        form.append("media", JSON.stringify(media));

        const response = await fetch(
          `https://api.telegram.org/bot${config.telegramBotToken}/sendMediaGroup`,
          {
            method: "POST",
            body: form,
            signal: AbortSignal.timeout(45_000),
          },
        );
        if (!response.ok) {
          logWarn(`Telegram media group send failed: HTTP ${response.status}.`);
        }
      }
    } catch (error) {
      logWarn(`Telegram photo delivery failed: ${(error as Error).message}`);
    }
  }
}

