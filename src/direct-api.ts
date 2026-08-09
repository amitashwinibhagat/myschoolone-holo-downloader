/**
 * Direct HTTP client for the MySchoolOne Pro portal.
 *
 * Bypasses Playwright entirely by using saved session cookies to make
 * HTTP requests directly. This is faster, cheaper (no AI), and more
 * reliable than the browser-based path for the common daily-download case.
 *
 * Strategy:
 * 1. Load cookies from the saved Playwright storage state
 * 2. Load the AJAX request structure captured by the last browser run
 *    (`daily-log-discovery.json`), which records the real endpoint and
 *    body parameter names/values (e.g. daily_planner_parent_ajax.php with
 *    `tdate` + `type`).
 * 3. Replay that request for each date to get attachment URLs
 * 4. Download attachments directly via HTTP
 * 5. Fall back to the legacy `dailydate=` POST only when no discovery data
 *    exists yet.
 */
import fs from "node:fs/promises";
import { config } from "./config.js";
import { dateInIndia } from "./utils.js";
import {
  loadDiscoveryFile,
  DATE_VALUE_PATTERN,
  type DiscoveredRequest,
  type DiscoveryFile,
  type RequestParameter,
} from "./direct-discovery.js";

const ATTACHMENT_PATTERN = /UploadFiles/i;
const DAILY_LOG_PATH = "/Web/LearningManagement/daily_planner_parent.php";
const FRESH_DISCOVERY_MS = 3 * 86_400_000;
/** Alternate `type` values to probe when the captured request returns no URLs. */
const PROBE_TYPE_VALUES = ["1", "2", "daily"];
/**
 * Shared UA for all direct HTTP requests. Keep in sync with the browser
 * channel's UA so Cloudflare sees one consistent fingerprint.
 */
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export interface DirectPollResult {
  urls: string[];
  dateLabel: string;
  /** Set when the fetch itself failed for this date (endpoint/session problem). */
  error?: string;
}

export interface DirectPollOutcome {
  results: DirectPollResult[];
  /** Whether the direct call was driven by a captured discovery file. */
  discoveryUsed: boolean;
  /** Whether the discovery file was captured recently (fresh = trustworthy). */
  discoveryFresh: boolean;
  /**
   * Whether the discovery captured real parameter values. Legacy files only
   * recorded parameter names (empty values), which are not strong enough
   * evidence to trust a zero-result reply.
   */
  discoveryComplete: boolean;
}

export interface Cookie {
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
export async function loadCookies(): Promise<Cookie[]> {
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

/** True when any saved cookie expires within the given horizon (ms). */
export async function sessionExpiresWithin(horizonMs: number): Promise<boolean> {
  const cookies = await loadCookies();
  const deadline = Date.now() + horizonMs;
  return cookies.some((c) => typeof c.expires === "number" && c.expires > 0 && c.expires * 1000 < deadline);
}

/**
 * Host-boundary match mirroring browser cookie semantics:
 * - a host-only domain (no leading dot) matches only the exact host,
 * - a domain cookie (leading dot) also matches its subdomains.
 * `school.example.com` therefore matches `school.example.com` and, with a
 * leading dot, `uploads.school.example.com` — but never `evilschool.example.com`
 * or `school.example.com.evil.net`.
 */
export function hostMatchesDomain(host: string, cookieDomain: string): boolean {
  const domainCookie = cookieDomain.startsWith(".");
  const domain = (domainCookie ? cookieDomain.slice(1) : cookieDomain).toLowerCase();
  const normalizedHost = host.toLowerCase();
  return normalizedHost === domain || (domainCookie && normalizedHost.endsWith(`.${domain}`));
}

/**
 * Convert Playwright storage-state cookies into a Cookie header string.
 * Exported so the session check can reuse the same domain/path matching.
 */
export function buildCookieHeader(cookies: Cookie[], url: URL): string {
  const host = url.hostname;
  return cookies
    .filter((c) => hostMatchesDomain(host, c.domain) && url.pathname.startsWith(c.path || "/"))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

/** True when a captured parameter should carry the target portal date. */
function isDateParameter(name: string, value: string): boolean {
  return DATE_VALUE_PATTERN.test(value) || /date/i.test(name);
}

/**
 * Substitute the target portal date into a captured parameter list. A parameter
 * is treated as the date field when its captured value looks like a date, or
 * when its name clearly indicates a date (e.g. `tdate`, `dailydate`). All other
 * captured values (e.g. `type`) are preserved so the replay matches what the
 * browser actually sent.
 */
export function replayBody(parameters: RequestParameter[], portalDate: string): string {
  const params = new URLSearchParams();
  let foundDate = false;
  for (const { name, value } of parameters) {
    if (isDateParameter(name, value)) {
      params.set(name, portalDate);
      foundDate = true;
    } else {
      params.set(name, value);
    }
  }
  if (!foundDate) params.set("dailydate", portalDate);
  return params.toString();
}

function replayQuery(parameters: RequestParameter[], portalDate: string): string {
  if (parameters.length === 0) return "";
  const params = new URLSearchParams();
  for (const { name, value } of parameters) {
    if (!value) continue; // legacy files carry names without values
    params.set(name, isDateParameter(name, value) ? portalDate : value);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

/**
 * Parse HTML for attachment URLs matching the UploadFiles pattern.
 * Extracts both <a href="...UploadFiles..."> links and <img src="..."> with upload paths.
 */
export function extractAttachmentUrls(html: string): string[] {
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
 * Pure decision for one redirect hop: returns the next request to issue, or
 * null when the redirect must not be followed (non-3xx, no Location header,
 * chain limit reached, or the target is not allowed). Mirrors the fetch
 * spec's method handling: 301/302/303 become GET, 307/308 keep method/body.
 */
export function nextRedirectRequest(
  status: number,
  location: string | null,
  currentUrl: string,
  isAllowed: (url: URL) => boolean,
  redirectsUsed: number,
  maxRedirects: number,
  method: string,
  body: BodyInit | null | undefined,
): { url: string; method: string; body: BodyInit | null | undefined } | null {
  if (status < 300 || status >= 400) return null;
  if (!location) return null;
  if (redirectsUsed >= maxRedirects) return null;
  let next: URL;
  try {
    next = new URL(location, currentUrl);
  } catch {
    return null;
  }
  if (!isAllowed(next)) return null;
  if (status === 301 || status === 302 || status === 303) {
    return { url: next.toString(), method: "GET", body: undefined };
  }
  return { url: next.toString(), method, body };
}

/**
 * Options for {@link fetchSameOrigin}.
 */
export interface SameOriginOptions {
  /**
   * Cookie jar used to recompute the Cookie header for each hop, so cookies
   * never follow a redirect to a host they are not scoped to.
   */
  cookies?: Cookie[];
  maxRedirects?: number;
}

/**
 * Fetch with manual redirect handling. Follows redirects only while the target
 * is allowed by `isAllowed`, so a manually-attached Cookie header can never be
 * forwarded to a different host. When `options.cookies` is set, the Cookie
 * header is rebuilt per hop from the jar (host-scoped) instead of being
 * carried over unchanged. Returns the last response — a 3xx when the
 * redirect chain is refused or exceeds the limit, so callers see a non-ok
 * response.
 */
export async function fetchSameOrigin(
  input: string,
  init: RequestInit,
  isAllowed: (url: URL) => boolean,
  options: SameOriginOptions = {},
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? 5;
  const requestHeaders = new Headers(init.headers);
  let url = input;
  let method = init.method ?? "GET";
  let body = init.body;
  const signal = init.signal;
  for (let redirects = 0; ; redirects += 1) {
    if (options.cookies) {
      const cookieHeader = buildCookieHeader(options.cookies, new URL(url));
      if (cookieHeader) requestHeaders.set("cookie", cookieHeader);
      else requestHeaders.delete("cookie");
    }
    const response = await fetch(url, { method, headers: requestHeaders, body, signal, redirect: "manual" });
    const next = nextRedirectRequest(
      response.status,
      response.headers.get("location"),
      url,
      isAllowed,
      redirects,
      maxRedirects,
      method,
      body,
    );
    if (!next) return response;
    ({ url, method, body } = next);
    if (next.body === undefined) {
      // The follow-up is a bodyless GET — drop body-only headers (the Cookie
      // header is recomputed above when a cookie jar was supplied).
      requestHeaders.delete("content-type");
      requestHeaders.delete("content-length");
    }
  }
}

/**
 * POST to the given portal path with the given body and extract attachment
 * URLs from the response (HTML or JSON).
 */
async function postAndExtract(
  cookies: Cookie[],
  baseUrl: URL,
  path: string,
  query: string,
  body: string,
  isoDate: string,
): Promise<DirectPollResult> {
  const headers: Record<string, string> = {
    Accept: "text/html, */*; q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "X-Requested-With": "XMLHttpRequest",
    Referer: new URL(DAILY_LOG_PATH, baseUrl).toString(),
    "User-Agent": DEFAULT_USER_AGENT,
  };

  const resolved = new URL(`${path}${query}`, baseUrl);
  if (resolved.origin !== baseUrl.origin) {
    throw new Error(`Refusing to POST to off-origin endpoint: ${resolved.origin}`);
  }

  const response = await fetchSameOrigin(
    resolved.toString(),
    {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(20_000),
    },
    (url) => url.origin === baseUrl.origin,
    { cookies },
  );

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching daily log data`);
  }

  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();

  if (contentType.includes("text/html") || text.includes("<")) {
    return { urls: extractAttachmentUrls(text), dateLabel: isoDate };
  }

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
    return { urls: extractAttachmentUrls(text), dateLabel: isoDate };
  }
}

/**
 * Gate for attachment downloads: the school host or any subdomain of it, on
 * the same protocol as the configured school URL, plus any hosts in
 * `config.attachmentAllowedHosts` (e.g. the MySchoolOne CloudFront CDN).
 * Look-alike hosts (`evilschool.example.com`, `school.example.com.evil.net`,
 * an unrelated CloudFront distribution) are rejected.
 */
export function attachmentHostAllowed(url: URL): boolean {
  const school = new URL(config.schoolUrl);
  if (url.protocol !== school.protocol) return false;
  // Leading dot: treat the school host like a domain cookie so its subdomains
  // are allowed (exact host still matches).
  if (hostMatchesDomain(url.hostname, `.${school.hostname}`)) return true;
  return config.attachmentAllowedHosts.some((host) => hostMatchesDomain(url.hostname, host));
}

/**
 * Download a single image attachment using the saved session cookies.
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

  // Never attach session cookies to a different host — reject absolute URLs
  // the portal content points at an off-origin (e.g. look-alike) domain.
  if (!attachmentHostAllowed(targetUrl)) return null;

  const headers: Record<string, string> = {
    Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
    Referer: new URL(DAILY_LOG_PATH, config.schoolUrl).toString(),
    "User-Agent": DEFAULT_USER_AGENT,
  };

  const response = await fetchSameOrigin(
    targetUrl.toString(),
    {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(20_000),
    },
    attachmentHostAllowed,
    { cookies },
  );

  if (!response.ok) return null;

  const contentType = response.headers.get("content-type") || "";
  const arrayBuffer = await response.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), contentType };
}

/** Resolve the correct `type` value by probing when the captured one returns nothing. */
async function resolveParameters(
  cookies: Cookie[],
  baseUrl: URL,
  path: string,
  query: string,
  parameters: RequestParameter[],
  portalDate: string,
  isoDate: string,
): Promise<RequestParameter[] | null> {
  const typeIndex = parameters.findIndex((p) => p.name === "type");
  if (typeIndex < 0) return null;
  for (const value of PROBE_TYPE_VALUES) {
    if (parameters[typeIndex].value === value) continue;
    const candidate = parameters.map((p, i) => (i === typeIndex ? { ...p, value } : p));
    const result = await postAndExtract(
      cookies,
      baseUrl,
      path,
      query,
      replayBody(candidate, portalDate),
      isoDate,
    ).catch(() => ({ urls: [], dateLabel: isoDate }));
    if (result.urls.length > 0) return candidate;
  }
  return null;
}

/**
 * High-level entry point: poll the portal for attachment URLs across the given
 * date range using direct HTTP requests (no browser).
 *
 * Returns discovered attachment URLs grouped by date, plus metadata about
 * whether a captured discovery file drove the requests and how fresh it is.
 */
export async function directPollAttachments(lookbackDays: number): Promise<DirectPollOutcome> {
  const cookies = await loadCookies();
  const baseUrl = new URL(config.schoolUrl);

  const discoveryFile = await loadDiscoveryFile();
  const discovery = pickEndpoint(discoveryFile);
  const plan: { path: string; queryParameters: RequestParameter[]; parameters: RequestParameter[] } =
    discovery
      ? {
          path: discovery.path,
          queryParameters: discovery.queryParameters,
          parameters: discovery.bodyParameters,
        }
      : {
          path: DAILY_LOG_PATH,
          queryParameters: [],
          parameters: [{ name: "dailydate", value: "01/01/2000" }],
        };

  const results: DirectPollResult[] = [];
  let effectiveParameters = plan.parameters;
  let resolved = false;

  for (let daysAgo = 0; daysAgo < lookbackDays; daysAgo += 1) {
    const iso = dateInIndia(new Date(Date.now() - daysAgo * 86_400_000));
    const [year, month, day] = iso.split("-");
    const portalDate = `${day}/${month}/${year}`;
    const query = replayQuery(plan.queryParameters, portalDate);

    try {
      let result = await postAndExtract(
        cookies,
        baseUrl,
        plan.path,
        query,
        replayBody(effectiveParameters, portalDate),
        iso,
      ).catch((error) => ({ urls: [], dateLabel: iso, error: (error as Error).message }));

      if (!resolved) {
        resolved = true;
        // First day: if the captured/default request fails or returns nothing,
        // probe alternate `type` values. A working variant is then used for all
        // remaining days.
        if (result.urls.length === 0) {
          const variant = await resolveParameters(
            cookies,
            baseUrl,
            plan.path,
            query,
            effectiveParameters,
            portalDate,
            iso,
          );
          if (variant) {
            effectiveParameters = variant;
            result = await postAndExtract(
              cookies,
              baseUrl,
              plan.path,
              query,
              replayBody(effectiveParameters, portalDate),
              iso,
            ).catch((error) => ({ urls: [], dateLabel: iso, error: (error as Error).message }));
          }
        }
      }

      if (result.error) {
        console.warn(`[direct] ${iso}: failed — ${result.error}`);
        results.push(result);
      } else {
        console.log(`[direct] ${iso}: ${result.urls.length} attachment link(s).`);
        results.push(result);
      }
    } catch (error) {
      console.warn(`[direct] ${iso}: failed — ${(error as Error).message}`);
      results.push({ urls: [], dateLabel: iso, error: (error as Error).message });
    }
  }

  return {
    results,
    discoveryUsed: Boolean(discovery),
    discoveryFresh: discoveryFresh(discoveryFile),
    discoveryComplete: discovery
      ? discovery.bodyParameters.length > 0 && discovery.bodyParameters.every((p) => p.value !== "")
      : false,
  };
}

function pickEndpoint(file: DiscoveryFile | null): DiscoveredRequest | null {
  if (!file || !Array.isArray(file.requests)) return null;
  // A protocol-relative path (//host/...) would make `new URL(path, baseUrl)`
  // resolve off-origin while the cookie header is still built for the school
  // origin — reject it.
  const posts = file.requests.filter(
    (r) => r.method === "POST" && r.path.startsWith("/") && !r.path.startsWith("//"),
  );
  posts.sort((a, b) => {
    const aHasDate = a.bodyParameters.some((p) => DATE_VALUE_PATTERN.test(p.value)) ? 1 : 0;
    const bHasDate = b.bodyParameters.some((p) => DATE_VALUE_PATTERN.test(p.value)) ? 1 : 0;
    return bHasDate - aHasDate || b.bodyParameters.length - a.bodyParameters.length;
  });
  return posts[0] ?? null;
}
export { pickEndpoint };

function discoveryFresh(file: DiscoveryFile | null): boolean {
  if (!file) return false;
  const capturedAt = Date.parse(file.capturedAt);
  if (Number.isNaN(capturedAt)) return false;
  return Date.now() - capturedAt < FRESH_DISCOVERY_MS;
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
