/**
 * Generic HTTP and cookie utilities for authenticated portal requests.
 *
 * Provides host-boundary-checked cookie handling, redirect following with
 * per-hop cookie scoping, and session state inspection.
 */
import fs from "node:fs/promises";
import { config } from "./config.js";

/**
 * Shared UA for all direct HTTP requests. Keep in sync with the browser
 * channel's UA so Cloudflare sees one consistent fingerprint.
 */
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

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

export interface StorageState {
  cookies: Cookie[];
  origins?: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

/**
 * Load cookies from the Playwright storage state file saved by `npm run login`.
 */
export async function loadCookies(statePath = config.sessionStatePath): Promise<Cookie[]> {
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
export async function sessionExpiresWithin(horizonMs: number, statePath = config.sessionStatePath): Promise<boolean> {
  const cookies = await loadCookies(statePath);
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
 */
export function buildCookieHeader(cookies: Cookie[], url: URL): string {
  const host = url.hostname;
  return cookies
    .filter((c) => hostMatchesDomain(host, c.domain) && url.pathname.startsWith(c.path || "/"))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
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
