/**
 * Direct HTTP client for the MySchoolOne Pro portal.
 *
 * Bypasses Playwright entirely by using saved session cookies to make
 * HTTP requests directly. This is faster, cheaper (no AI), and more
 * reliable than the browser-based path for the common daily-download case.
 *
 * Strategy:
 * 1. Load cookies from the saved Playwright storage state
 * 2. Fetch the Daily Log page HTML
 * 3. Extract the AJAX endpoint pattern from the page's JavaScript
 * 4. Call the endpoint for each date to get attachment URLs
 * 5. Download attachments directly via HTTP
 */
import fs from "node:fs/promises";
import { config } from "./config.js";
import { dateInIndia } from "./utils.js";

const ATTACHMENT_PATTERN = /UploadFiles/i;
const DAILY_LOG_PATH = "/Web/LearningManagement/daily_planner_parent.php";

export interface DirectPollResult {
  urls: string[];
  dateLabel: string;
}

interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

interface StorageState {
  cookies: Cookie[];
  origins?: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

/**
 * Load cookies from the Playwright storage state file saved by `npm run login`.
 */
async function loadCookies(): Promise<Cookie[]> {
  const statePath = config.sessionStatePath;
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const state = JSON.parse(raw) as StorageState;
    return state.cookies || [];
  } catch (error) {
    throw new Error(
      `Cannot load session state from ${statePath}. ` +
        `Run "npm run login" first to save your browser session.\n` +
        `Original error: ${(error as Error).message}`,
    );
  }
}

/**
 * Convert Playwright storage-state cookies into a Cookie header string.
 */
function cookieHeader(cookies: Cookie[], url: URL): string {
  const origin = url.origin;
  return cookies
    .filter((c) => {
      const domain = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
      return origin.endsWith(domain) && url.pathname.startsWith(c.path || "/");
    })
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

/**
 * Build form-encoded body for the displaysubjects() AJAX call.
 * The portal uses a date parameter in DD/MM/YYYY format.
 */
function buildDateRequestBody(portalDate: string): string {
  return new URLSearchParams({ dailydate: portalDate }).toString();
}

/**
 * Fetch the Daily Log page and extract attachment URLs from the HTML.
 */
async function fetchDailyLogHtml(cookies: Cookie[], date: string): Promise<string> {
  const baseUrl = new URL(config.schoolUrl);
  const url = new URL(DAILY_LOG_PATH, baseUrl);
  const headers: Record<string, string> = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
    Referer: baseUrl.toString(),
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  };

  const cookieStr = cookieHeader(cookies, url);
  if (cookieStr) headers.Cookie = cookieStr;

  const response = await fetch(url.toString(), {
    method: "GET",
    headers,
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching Daily Log page`);
  }

  return response.text();
}

/**
 * Parse HTML for attachment URLs matching the UploadFiles pattern.
 * Extracts both <a href="...UploadFiles..."> links and <img src="..."> with upload paths.
 */
function extractAttachmentUrls(html: string): string[] {
  const urls = new Set<string>();

  // Match href and src attributes containing UploadFiles paths
  const hrefPattern = /href=["']([^"']*UploadFiles[^"']*)["']/gi;
  const srcPattern = /src=["']([^"']*UploadFiles[^"']*)["']/gi;

  let match: RegExpExecArray | null;
  while ((match = hrefPattern.exec(html)) !== null) {
    urls.add(match[1]);
  }
  while ((match = srcPattern.exec(html)) !== null) {
    urls.add(match[1]);
  }

  return [...urls];
}

/**
 * Try to discover the AJAX endpoint from inline JavaScript in the page.
 * The portal typically has a displaysubjects(date) function that calls an endpoint.
 */
function extractAjaxEndpoint(html: string): string | null {
  // Look for AJAX/fetch calls in the page's JavaScript
  const patterns = [
    /ajax\s*\(\s*\{[^}]*url\s*:\s*["']([^"']+)["']/i,
    /fetch\s*\(\s*["']([^"']+)["']/i,
    /\.post\s*\(\s*["']([^"']+)["']/i,
    /\.get\s*\(\s*["']([^"']+)["']/i,
    /url\s*:\s*["']([^"']*daily[^"']*)["']/i,
    /url\s*:\s*["']([^"']*planner[^"']*)["']/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1];
  }

  return null;
}

/**
 * Attempt to fetch daily log data via the discovered AJAX endpoint.
 * Falls back to parsing the initial page HTML if no AJAX endpoint is found.
 */
async function fetchAttachmentsForDate(
  cookies: Cookie[],
  baseUrl: URL,
  portalDate: string,
  isoDate: string,
): Promise<DirectPollResult> {
  const headers: Record<string, string> = {
    Accept: "text/html, */*; q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "X-Requested-With": "XMLHttpRequest",
    Referer: new URL(DAILY_LOG_PATH, baseUrl).toString(),
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  };

  const cookieStr = cookieHeader(cookies, baseUrl);
  if (cookieStr) headers.Cookie = cookieStr;

  const body = buildDateRequestBody(portalDate);

  // Try the same page as an AJAX endpoint (common pattern for PHP portals)
  const ajaxUrl = new URL(DAILY_LOG_PATH, baseUrl);
  const response = await fetch(ajaxUrl.toString(), {
    method: "POST",
    headers,
    body,
    redirect: "follow",
  });

  if (!response.ok) {
    return { urls: [], dateLabel: isoDate };
  }

  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();

  // If it returned HTML, parse it for attachment URLs
  if (contentType.includes("text/html") || text.includes("<")) {
    const urls = extractAttachmentUrls(text);
    return { urls, dateLabel: isoDate };
  }

  // If it returned JSON, try to extract URLs from the response
  try {
    const json = JSON.parse(text);
    const urls: string[] = [];
    const extractUrls = (obj: any): void => {
      if (typeof obj === "string" && ATTACHMENT_PATTERN.test(obj)) {
        urls.push(obj);
      } else if (Array.isArray(obj)) {
        obj.forEach(extractUrls);
      } else if (obj && typeof obj === "object") {
        Object.values(obj).forEach(extractUrls);
      }
    };
    extractUrls(json);
    return { urls, dateLabel: isoDate };
  } catch {
    // Not JSON — try regex extraction on the raw text
    return { urls: extractAttachmentUrls(text), dateLabel: isoDate };
  }
}

/**
 * Make a direct HTTP request to download an image attachment.
 * Uses the saved session cookies for authentication.
 */
export async function fetchAttachmentBuffer(
  cookies: Cookie[],
  url: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  let targetUrl: URL;
  try {
    targetUrl = new URL(url, config.schoolUrl);
  } catch {
    return null;
  }

  const headers: Record<string, string> = {
    Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
    Referer: new URL(DAILY_LOG_PATH, config.schoolUrl).toString(),
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  };

  const cookieStr = cookieHeader(cookies, targetUrl);
  if (cookieStr) headers.Cookie = cookieStr;

  const response = await fetch(targetUrl.toString(), {
    method: "GET",
    headers,
    redirect: "follow",
  });

  if (!response.ok) return null;

  const contentType = response.headers.get("content-type") || "";
  const arrayBuffer = await response.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), contentType };
}

/**
 * High-level entry point: poll the portal for attachment URLs across the given
 * date range using direct HTTP requests (no browser).
 *
 * Returns discovered attachment URLs grouped by date.
 */
export async function directPollAttachments(
  lookbackDays: number,
): Promise<DirectPollResult[]> {
  const cookies = await loadCookies();
  const baseUrl = new URL(config.schoolUrl);
  const results: DirectPollResult[] = [];

  for (let daysAgo = 0; daysAgo < lookbackDays; daysAgo += 1) {
    const iso = dateInIndia(new Date(Date.now() - daysAgo * 86_400_000));
    const [year, month, day] = iso.split("-");
    const portalDate = `${day}/${month}/${year}`;

    try {
      const result = await fetchAttachmentsForDate(cookies, baseUrl, portalDate, iso);
      console.log(`[direct] ${iso}: ${result.urls.length} attachment link(s).`);
      results.push(result);
    } catch (error) {
      console.warn(`[direct] ${iso}: failed — ${(error as Error).message}`);
      results.push({ urls: [], dateLabel: iso });
    }
  }

  return results;
}

/**
 * Check if the direct-poll path is available (session state file exists and
 * has valid cookies). Used to decide whether to attempt direct-poll or fall
 * back to browser mode.
 */
export async function isDirectPollAvailable(): Promise<boolean> {
  try {
    const cookies = await loadCookies();
    return cookies.length > 0;
  } catch {
    return false;
  }
}
