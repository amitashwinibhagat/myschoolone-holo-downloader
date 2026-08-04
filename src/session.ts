/**
 * Pre-run session health check.
 *
 * Performs a cheap, browser-free GET with the saved cookies and classifies the
 * session so callers can decide whether the direct path is worth trying, warn
 * about expiring cookies, and avoid blind retries when a human must re-login.
 */
import { config } from "./config.js";
import { loadCookies, sessionExpiresWithin, buildCookieHeader, DEFAULT_USER_AGENT } from "./direct-api.js";

export type SessionStatus = "ok" | "expired" | "challenge" | "unreachable";

export interface SessionCheckResult {
  status: SessionStatus;
  reason?: string;
  /** True when at least one saved cookie expires within the warning horizon. */
  cookiesExpiringSoon: boolean;
}

const PASSWORD_INPUT = /<input[^>]*type=["']?password["']?[^>]*>/i;
const LOGIN_PATH = /\/(login|signin|sign-in|account)\b/i;
const CHALLENGE_MARKERS = [
  "Verifying you are human",
  "Just a moment",
  "Checking your browser",
  "needs to review the security of your connection",
];
const SESSION_EXPIRY_WARNING_MS = 48 * 60 * 60 * 1000;

function classifyBody(text: string, finalUrl: string): "ok" | "expired" | "challenge" {
  const lower = text.toLowerCase();
  if (CHALLENGE_MARKERS.some((marker) => lower.includes(marker.toLowerCase()))) return "challenge";
  if (PASSWORD_INPUT.test(text) || LOGIN_PATH.test(finalUrl)) return "expired";
  return "ok";
}

/** Pure classifier, exported for tests. */
export { classifyBody as classifySessionBody };

/**
 * Check whether the saved session is usable. Returns "expired" when there are
 * no cookies or the portal answers with a login form, "challenge" when a bot
 * interstitial is showing, "unreachable" when the portal cannot be reached,
 * and "ok" otherwise.
 */
export async function checkSession(): Promise<SessionCheckResult> {
  let cookies: Awaited<ReturnType<typeof loadCookies>>;
  try {
    cookies = await loadCookies();
  } catch (error) {
    return { status: "expired", reason: (error as Error).message, cookiesExpiringSoon: false };
  }
  if (cookies.length === 0) {
    return { status: "expired", reason: "No cookies in the saved session state.", cookiesExpiringSoon: false };
  }

  const cookiesExpiringSoon = await sessionExpiresWithin(SESSION_EXPIRY_WARNING_MS).catch(() => false);
  const url = new URL("/Web/LearningManagement/daily_planner_parent.php", config.schoolUrl);

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
        Cookie: buildCookieHeader(cookies, url),
      },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    const status = classifyBody(text, response.url || url.toString());
    if (status === "expired") {
      return {
        status,
        reason: `Portal answered HTTP ${response.status} with a login form.`,
        cookiesExpiringSoon,
      };
    }
    return { status, reason: `HTTP ${response.status}.`, cookiesExpiringSoon };
  } catch (error) {
    return { status: "unreachable", reason: (error as Error).message, cookiesExpiringSoon };
  }
}
