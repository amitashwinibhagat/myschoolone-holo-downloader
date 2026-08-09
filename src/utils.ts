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

export interface IndiaTime {
  weekday: number;
  hour: number;
  minute: number;
  date: string;
}

/** Calendar parts for Asia/Kolkata without depending on the Mac's local timezone. */
export function indiaTime(date = new Date()): IndiaTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    weekday: weekdays[values.weekday] ?? -1,
    hour: Number.parseInt(values.hour, 10),
    minute: Number.parseInt(values.minute, 10),
    date: `${values.year}-${values.month}-${values.day}`,
  };
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

/**
 * Strip password-input values from serialized HTML before it is written to
 * disk (e.g. failure debug captures), so a filled login form can never leak
 * the password into a local file. Defense-in-depth: callers should also clear
 * the live DOM values before serializing, since browsers serialize the `value`
 * attribute (default value) and not the current property.
 */
export function redactPasswordValues(html: string): string {
  // Match the whole password input tag (type= anywhere inside it, quoted or
  // unquoted), then mask any value attribute inside, so attribute order and
  // quoting style do not matter. `>` inside a quoted value still truncates the
  // tag match — the DOM-side clearing in sanitizedPageHtml covers live pages.
  return html.replace(/<input\b[^>]*\btype=(["']?)password\1[^>]*>/gi, (tag) =>
    tag.replace(/\bvalue=(["']?)[^"'\s>]*\1/gi, 'value="********"'),
  );
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
