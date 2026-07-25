import crypto from "node:crypto";
import path from "node:path";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sha256(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function dateInIndia(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

export function sanitizeFilename(input: string): string {
  const cleaned = input
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
  return cleaned || "school-photo";
}

export function extensionForContentType(contentType: string): string {
  const value = contentType.toLowerCase().split(";")[0].trim();
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/heic": ".heic",
    "image/heif": ".heif",
    "image/avif": ".avif",
  };
  return map[value] || "";
}

export function filenameFromUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const base = path.basename(decodeURIComponent(parsed.pathname));
    return base && base !== "/" ? base : "school-photo";
  } catch {
    return "school-photo";
  }
}

export function filenameFromDisposition(disposition: string | undefined): string | undefined {
  if (!disposition) return undefined;
  const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (utf8) return decodeURIComponent(utf8.replace(/["']/g, ""));
  const basic = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  return basic?.trim();
}
