import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import type { ChatCompletion, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { launchBrowser, waitForHumanCheck } from "./browser.js";
import { config } from "./config.js";
import { DownloadManager } from "./downloads.js";
import { HoloClient } from "./holo.js";
import { DownloadStore, type RunRecord } from "./store.js";
import { acquireRunLock } from "./run-lock.js";
import { notify } from "./notify.js";
import { logInfo, logWarn, logError } from "./log.js";
import { sanitizedPageHtml } from "./portal.js";
import { sleep } from "./utils.js";

const SYSTEM_PROMPT = `You are a careful browser agent operating the MySchoolOne Pro parent portal for Amit.

Your single goal is to download photo/image attachments from your child's recent daily school updates.

Rules:
1. Stay inside the configured school portal. Do not browse elsewhere.
2. This is read-only. Never send messages, submit forms, react, acknowledge, delete, edit, upload, pay, or change settings.
3. Navigate to the area most likely named Daily Updates, Communications, e-Almanac, Classroom Updates, Activity Updates, Diary, Circulars, or similar.
4. Process the newest updates first, covering approximately the last ${config.lookbackDays} days.
5. Open each relevant update. When image attachments, a lightbox, gallery, carousel, or full-size photo appears, call save_visible_images.
6. If a gallery has next/previous arrows, save the current image, move to the next image, and continue until you return to an already-seen image or reach the end. Duplicate detection is automatic.
7. Ignore PDFs, videos, logos, profile pictures, decorative icons, advertisements, and unrelated files.
8. Prefer click_text for obvious labels. Use click coordinates for icons, thumbnails and unlabeled controls.
9. If a login screen, OTP, CAPTCHA, expired session, account chooser, or consent screen blocks access, stop with finish and clearly state what Amit must do manually.
10. Finish only after the recent update list has been inspected and all reachable image attachments have been saved.

Be conservative: do not click anything that could communicate with the school or alter portal data.`;

function trimOldImages(messages: ChatCompletionMessageParam[], keep = 3): void {
  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const chunk of message.content) {
      if (chunk.type !== "image_url") continue;
      seen += 1;
      if (seen > keep) {
        // Replace the image chunk with a text placeholder so the request stays
        // small. The SDK types do not model this in-place mutation, so cast.
        const placeholder = chunk as unknown as { type: "text"; text: string };
        placeholder.type = "text";
        placeholder.text = "[older screenshot removed]";
        delete (chunk as { image_url?: unknown }).image_url;
      }
    }
  }
}

async function observation(page: Page): Promise<ChatCompletionMessageParam> {
  await page.waitForTimeout(700);
  const screenshot = await page.screenshot({ type: "png", animations: "disabled" });
  const pageText = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `<observation>\nURL: ${page.url()}\nTitle: ${await page.title().catch(() => "")}\nVisible text (may be truncated):\n${pageText.slice(0, 9_000)}\n`,
      },
      { type: "image_url", image_url: { url: `data:image/png;base64,${screenshot.toString("base64")}` } },
      { type: "text", text: "\n</observation>" },
    ],
  };
}

async function executeTool(name: string, args: Record<string, unknown>, page: Page, downloads: DownloadManager): Promise<string> {
  switch (name) {
    case "click": {
      const x = Math.round((Number(args.x) / 1000) * config.viewportWidth);
      const y = Math.round((Number(args.y) / 1000) * config.viewportHeight);
      await page.mouse.click(x, y);
      await page.waitForTimeout(900);
      return `Clicked ${args.element} at pixel (${x}, ${y}).`;
    }
    case "click_text": {
      const locator = page.getByText(String(args.text), { exact: false }).first();
      await locator.waitFor({ state: "visible", timeout: 6_000 });
      await locator.click({ timeout: 6_000 });
      await page.waitForTimeout(900);
      return `Clicked visible text: ${args.text}`;
    }
    case "scroll": {
      const amount = Math.max(200, Math.min(1200, Number(args.amount)));
      await page.mouse.wheel(0, args.direction === "up" ? -amount : amount);
      await page.waitForTimeout(700);
      return `Scrolled ${args.direction} by ${amount}px.`;
    }
    case "save_visible_images":
      return downloads.saveVisibleImages(page);
    case "press_key":
      await page.keyboard.press(String(args.key));
      await page.waitForTimeout(700);
      return `Pressed ${args.key}.`;
    case "go_back":
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => null);
      await page.waitForTimeout(800);
      return "Went back one page.";
    case "wait":
      await sleep(Math.max(1, Math.min(10, Number(args.seconds))) * 1_000);
      return `Waited ${args.seconds} seconds.`;
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function writeDebug(page: Page, step: number): Promise<void> {
  const dir = path.resolve("debug");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => undefined);
  await page.screenshot({ path: path.join(dir, `failed-step-${step}.png`), fullPage: false }).catch(() => undefined);
  await fs.writeFile(path.join(dir, `failed-step-${step}.html`), await sanitizedPageHtml(page), { mode: 0o600 });
}

async function main(): Promise<void> {
  if (config.aiMode === "none") {
    logError("AI agent mode is disabled (AI_MODE=none). Use 'npm run daily' for deterministic downloads.");
    process.exitCode = 1;
    return;
  }

  const startedAt = new Date().toISOString();
  const store = new DownloadStore(config.stateDir);
  await store.load();
  const downloads = new DownloadManager(store);
  const lock = await acquireRunLock(config.stateDir, "manual", "manual");
  if (!lock.acquired) {
    const message = "Another downloader command is using the browser profile. Wait for it to finish.";
    logWarn(message);
    throw new Error(message);
  }

  try {
    const browser = await launchBrowser(downloads);
    const holo = new HoloClient();
    try {
      let page = browser.getPage();
      await page.goto(config.schoolUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await waitForHumanCheck(page);

      const messages: ChatCompletionMessageParam[] = [{ role: "system", content: SYSTEM_PROMPT }];

      for (let step = 1; step <= config.maxSteps; step += 1) {
        page = browser.getPage();
        logInfo(`Step ${step}/${config.maxSteps}: ${page.url()}`);
        messages.push(await observation(page));
        trimOldImages(messages, 3);

        try {
          const response: ChatCompletion = await holo.next(messages);
          const assistant = response.choices[0]?.message;
          const call = assistant?.tool_calls?.[0];
          if (!call) throw new Error("Holo returned no tool call.");
          if (call.type !== "function") throw new Error(`Unexpected tool call type: ${call.type}`);

          const name = call.function.name;
          const args: Record<string, unknown> = JSON.parse(call.function.arguments || "{}");
          logInfo(`Holo → ${name} ${JSON.stringify(args)}`);

          messages.push({
            role: "assistant",
            content: assistant.content || "",
            tool_calls: assistant.tool_calls,
          });

          if (name === "finish") {
            logInfo(`Finished: ${args.summary}`);
            await downloads.flush();
            await store.markSuccessfulRun();
            const stats = downloads.stats();
            await recordAgentRun(store, startedAt, {
              outcome: "success",
              message: typeof args.summary === "string" ? args.summary : "Agent finished.",
              saved: stats.saved,
              duplicates: stats.duplicates,
            });
            if (stats.saved > 0) await notify("School photos", `${stats.saved} new photo(s) saved by agent.`);
            return;
          }

          const result = await executeTool(name, args, page, downloads);
          logInfo(result);
          messages.push({ role: "tool", tool_call_id: call.id, content: result });
        } catch (error) {
          logError(`Step ${step} failed: ${(error as Error).message}`);
          await writeDebug(page, step);
          messages.push({
            role: "user",
            content: `<tool_error>${(error as Error).message}. Recover safely; do not repeat a failing action blindly.</tool_error>`,
          });
        }
      }

      throw new Error(`Agent reached MAX_STEPS=${config.maxSteps} without finishing.`);
    } finally {
      await browser.context.close();
    }
  } catch (error) {
    // Record the failed run so /status and failure streaks reflect it.
    await downloads.flush();
    await recordAgentRun(store, startedAt, { outcome: "failure", message: (error as Error).message });
    throw error;
  } finally {
    await lock.release();
  }
}

async function recordAgentRun(
  store: DownloadStore,
  startedAt: string,
  info: { outcome: "success" | "failure"; message: string; saved?: number; duplicates?: number },
): Promise<void> {
  const record: RunRecord = {
    startedAt,
    finishedAt: new Date().toISOString(),
    source: "manual",
    mode: "agent",
    transport: "browser",
    outcome: info.outcome,
    saved: info.saved ?? 0,
    duplicates: info.duplicates ?? 0,
    failures: info.outcome === "failure" ? 1 : 0,
    daysChecked: 0,
    error: info.outcome === "failure" ? info.message : undefined,
  };
  await store.recordRun(record);
}

main().catch(async (error) => {
  logError(`\nFatal error: ${(error as Error).stack || (error as Error).message}`);
  await notify("School photos — agent FAILED", (error as Error).message.slice(0, 180));
  process.exitCode = 1;
});
