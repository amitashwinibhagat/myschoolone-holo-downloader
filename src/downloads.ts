import fs from "node:fs/promises";
import path from "node:path";
import type { Download, Page } from "playwright";
import sharp from "sharp";
import { config } from "./config.js";
import { DownloadStore } from "./store.js";
import {
  dateInIndia,
  extensionForContentType,
  filenameFromDisposition,
  filenameFromUrl,
  sanitizeFilename,
  sha256,
} from "./utils.js";

/** Send a photo to Telegram so it arrives directly in the chat. */
async function sendPhotoToTelegram(buffer: Buffer, caption: string): Promise<void> {
  if (!config.telegramBotToken || !config.telegramChatId) return;
  const form = new FormData();
  form.append("chat_id", config.telegramChatId);
  form.append("photo", new Blob([new Uint8Array(buffer)], { type: "image/jpeg" }), "photo.jpg");
  form.append("caption", caption);
  await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendPhoto`, {
    method: "POST",
    body: form,
  }).catch((err) => console.warn(`  ! Telegram photo send failed: ${(err as Error).message}`));
}

interface CandidateImage {
  url: string;
  width: number;
  height: number;
  alt: string;
}

export interface SaveResult {
  saved: boolean;
  duplicate: boolean;
  path?: string;
  reason?: string;
}

export class DownloadManager {
  constructor(private readonly store: DownloadStore) {}

  async captureNativeDownload(download: Download): Promise<void> {
    try {
      const stream = await download.createReadStream();
      if (!stream) return;
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      const result = await this.saveBuffer(
        Buffer.concat(chunks),
        download.suggestedFilename(),
        undefined,
        "application/octet-stream",
      );
      if (result.saved) console.log(`  ✓ Downloaded ${result.path}`);
    } catch (error) {
      console.warn(`  ! Native download could not be captured: ${(error as Error).message}`);
    }
  }

  async saveVisibleImages(page: Page): Promise<string> {
    const candidates = await page.evaluate(({ minWidth, minHeight }) => {
      const output = new Map<string, CandidateImage>();
      for (const image of Array.from(document.images)) {
        const src = image.currentSrc || image.src;
        const anchor = image.closest("a")?.href;
        const largeEnough = image.naturalWidth >= minWidth || image.naturalHeight >= minHeight;
        const urls = largeEnough ? [src, anchor].filter(Boolean) : [anchor].filter(Boolean);
        for (const url of urls) {
          if (!url) continue;
          output.set(url, {
            url,
            width: image.naturalWidth,
            height: image.naturalHeight,
            alt: image.alt || "",
          });
        }
      }
      return [...output.values()];
    }, { minWidth: config.minImageWidth, minHeight: config.minImageHeight });

    if (candidates.length === 0) {
      return "No large visible images were detected on this screen.";
    }

    let saved = 0;
    let duplicates = 0;
    const failures: string[] = [];

    for (const candidate of candidates) {
      try {
        const result = await this.fetchAndSave(page, candidate);
        if (result.saved) {
          saved += 1;
          console.log(`  ✓ Saved ${result.path}`);
        } else if (result.duplicate) {
          duplicates += 1;
        } else if (result.reason) {
          failures.push(result.reason);
        }
      } catch (error) {
        failures.push(`${candidate.url.slice(0, 90)}: ${(error as Error).message}`);
      }
    }

    return `Visible-image scan finished: ${saved} new saved, ${duplicates} duplicates, ${failures.length} skipped/failed.`;
  }

  /** Download a single attachment/image URL directly (deterministic daily run). */
  async saveFromUrl(page: Page, url: string, alt = "", dateLabel?: string): Promise<SaveResult> {
    return this.fetchAndSave(page, { url, width: 0, height: 0, alt }, dateLabel);
  }

  private async fetchAndSave(page: Page, candidate: CandidateImage, dateLabel?: string): Promise<SaveResult> {
    if (candidate.url.startsWith("data:image/")) {
      const match = candidate.url.match(/^data:([^;,]+)(?:;charset=[^;,]+)?;base64,(.+)$/);
      if (!match) return { saved: false, duplicate: false, reason: "Unsupported data image" };
      return this.saveBuffer(Buffer.from(match[2], "base64"), candidate.alt, candidate.url, match[1], dateLabel);
    }

    if (candidate.url.startsWith("blob:")) {
      const encoded = await page.evaluate(async (url) => {
        const response = await fetch(url);
        const contentType = response.headers.get("content-type") || "image/jpeg";
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = "";
        for (let index = 0; index < bytes.length; index += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
        }
        return { base64: btoa(binary), contentType };
      }, candidate.url);
      return this.saveBuffer(Buffer.from(encoded.base64, "base64"), candidate.alt, candidate.url, encoded.contentType);
    }

    const response = await page.context().request.get(candidate.url, {
      headers: { referer: page.url() },
      failOnStatusCode: false,
      timeout: 30_000,
    });
    if (!response.ok()) {
      return { saved: false, duplicate: false, reason: `HTTP ${response.status()} for image` };
    }

    const headers = response.headers();
    const contentType = headers["content-type"] || "";
    const body = await response.body();
    const imageLike = contentType.startsWith("image/") || /\.(jpe?g|png|webp|gif|heic|heif|avif)(?:$|\?)/i.test(candidate.url);
    if (!imageLike) {
      return { saved: false, duplicate: false, reason: `Not an image (${contentType || "unknown type"})` };
    }

    const suggested = filenameFromDisposition(headers["content-disposition"]) || candidate.alt || filenameFromUrl(candidate.url);
    return this.saveBuffer(body, suggested, candidate.url, contentType, dateLabel);
  }

  private async saveBuffer(
    body: Buffer,
    suggestedName: string | undefined,
    sourceUrl: string | undefined,
    contentType: string,
    dateLabel?: string,
  ): Promise<SaveResult> {
    if (body.length < 8_000) {
      return { saved: false, duplicate: false, reason: "Image was smaller than 8 KB" };
    }

    const hash = sha256(body);
    if (this.store.hasHash(hash)) return { saved: false, duplicate: true };

    // Compress after dedupe so the hash always represents the original file.
    let output = body;
    let outputType = contentType;
    if (config.compressImages) {
      try {
        output = await sharp(body)
          .resize({ width: config.maxDimension, height: config.maxDimension, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: config.jpegQuality, mozjpeg: true })
          .toBuffer();
        outputType = "image/jpeg";
      } catch {
        // Not a decodable image (e.g. HEIC without codec) — save original.
      }
    }

    const folder = path.join(config.downloadDir, dateLabel || dateInIndia());
    await fs.mkdir(folder, { recursive: true });

    let name = sanitizeFilename(suggestedName || "school-photo");
    let extension = path.extname(name);
    if (!extension) extension = extensionForContentType(outputType) || ".jpg";
    if (outputType === "image/jpeg") extension = ".jpg";
    name = path.basename(name, path.extname(name));

    const filename = `${hash.slice(0, 10)}-${name}${extension}`;
    const destination = path.join(folder, filename);
    await fs.writeFile(destination, output);

    this.store.add({
      hash,
      sourceUrl,
      filename,
      savedPath: destination,
      downloadedAt: new Date().toISOString(),
    });
    await this.store.save();

    // Deliver the compressed image to Telegram.
    await sendPhotoToTelegram(output, `${dateLabel || dateInIndia()} — ${name}`);

    return { saved: true, duplicate: false, path: destination };
  }
}
