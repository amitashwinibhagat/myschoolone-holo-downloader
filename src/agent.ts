import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { launchBrowser, waitForHumanCheck } from "./browser.js";
import { config } from "./config.js";
import { DownloadManager } from "./downloads.js";
import { HoloClient } from "./holo.js";
import { DownloadStore } from "./store.js";
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

function trimOldImages(messages: any[], keep = 3): void {
  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const chunk of message.content) {
      if (chunk.type !== "image_url") continue;
      seen += 1;
      if (seen > keep) {
        chunk.type = "text";
        chunk.text = "[older screenshot removed]";
        delete chunk.image_url;
      }
    }
  }
}

async function observation(page: Page): Promise<any> {
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

async function executeTool(name: string, args: any, page: Page, downloads: DownloadManager): Promise<string> {
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
  await fs.mkdir(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `failed-step-${step}.png`), fullPage: false }).catch(() => undefined);
  await fs.writeFile(path.join(dir, `failed-step-${step}.html`), await page.content().catch(() => ""));
}

async function main(): Promise<void> {
  const store = new DownloadStore(config.stateDir);
  await store.load();
  const downloads = new DownloadManager(store);
  const browser = await launchBrowser(downloads);
  const holo = new HoloClient();

  try {
    let page = browser.getPage();
    await page.goto(config.schoolUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await waitForHumanCheck(page);

    const messages: any[] = [{ role: "system", content: SYSTEM_PROMPT }];

    for (let step = 1; step <= config.maxSteps; step += 1) {
      page = browser.getPage();
      console.log(`\nStep ${step}/${config.maxSteps}: ${page.url()}`);
      messages.push(await observation(page));
      trimOldImages(messages, 3);

      try {
        const response = await holo.next(messages);
        const assistant = response.choices[0]?.message;
        const call = assistant?.tool_calls?.[0];
        if (!call) throw new Error("Holo returned no tool call.");

        const name = call.function.name;
        const args = JSON.parse(call.function.arguments || "{}");
        console.log(`Holo → ${name}`, args);

        messages.push({
          role: "assistant",
          content: assistant.content || "",
          tool_calls: assistant.tool_calls,
        });

        if (name === "finish") {
          console.log(`\nFinished: ${args.summary}`);
          await store.markSuccessfulRun();
          return;
        }

        const result = await executeTool(name, args, page, downloads);
        console.log(result);
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      } catch (error) {
        console.error(`Step ${step} failed: ${(error as Error).message}`);
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
}

main().catch((error) => {
  console.error(`\nFatal error: ${(error as Error).stack || (error as Error).message}`);
  process.exitCode = 1;
});
