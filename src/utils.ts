import crypto from "node:crypto";
import path from "node:path";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Map an async function over `items` with at most `limit` tasks in flight at
 * once. Results preserve input order. A task that throws does not cancel or
 * reject its siblings — callers that need per-item isolation should catch
 * inside `fn` (as the download loops do).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    // The read+increment of `next` is synchronous (no await between), so it is
    // safe to share across workers on the single-threaded event loop.
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
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

/** Convert ISO date (YYYY-MM-DD) to portal date format (DD/MM/YYYY). */
export function isoToPortalDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  return `${day}/${month}/${year}`;
}

/** Return an ISO date string (YYYY-MM-DD) for `daysAgo` days prior in IST. */
export function daysAgoIso(daysAgo: number): string {
  return dateInIndia(new Date(Date.now() - daysAgo * 86_400_000));
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

/**
 * Map a cryptic run failure to a one-line next step for the user.
 * Returns undefined when the error is already self-explanatory, so callers
 * only append a hint when it adds signal. Pure — safe to unit-test.
 */
export function actionableHintFor(error: unknown): string | undefined {
  const message = (error as Error)?.message || "";
  if (/log ?in|sign ?in|session expired|not authenticated/i.test(message)) {
    return "Next step: run `npm run login` to restore the portal session.";
  }
  if (/executable doesn't exist|browser executable/i.test(message)) {
    return "Next step: run `npm run install-browser`, then rerun.";
  }
  if (/target closed|has been closed|failed to launch/i.test(message)) {
    return "Next step: the browser closed mid-run — just rerun and leave the browser window alone.";
  }
  if (/no frame with given id|frame has been detached/i.test(message)) {
    return "Next step: transient portal hiccup — just rerun.";
  }
  if (/verifying you are human|just a moment|checking your browser|cloudflare/i.test(message)) {
    return "Next step: stuck on the portal human-check — rerun with HEADLESS=false and solve it once.";
  }
  if (/err_name_not_resolved|enotfound|econnrefused|enetunreach|network.*unreachable|no internet/i.test(message)) {
    return "Next step: check your internet connection and rerun.";
  }
  if (/timeout|timed out/i.test(message)) {
    return "Next step: the portal is responding slowly — rerun; if it persists, run `npm run health`.";
  }
  return undefined;
}

export function filenameFromDisposition(disposition: string | undefined): string | undefined {
  if (!disposition) return undefined;
  const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (utf8) return decodeURIComponent(utf8.replace(/["']/g, ""));
  const basic = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  return basic?.trim();
}
