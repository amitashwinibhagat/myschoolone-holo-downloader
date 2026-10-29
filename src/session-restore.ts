/**
 * Reuse the saved portal session inside the browser.
 *
 * `npm run login` writes `state/browser-storage-state.json`, and the cloud
 * workflow already syncs that file through R2 — but until now only the
 * direct-HTTP paths ever read it. The browser always started cold and paid for
 * a fresh `logincheck.php` POST, which is both the slowest part of a run and the
 * 28% sign-in-failure bucket in the run history (7 of the last 25 scheduled
 * runs).
 *
 * Injecting those cookies after launch lets an unexpired session skip sign-in
 * entirely. This does not authenticate: it replays a session the user already
 * authenticated, exactly as the direct-poll path already does. If the portal
 * rejects the cookies, the login form simply reappears and `ensureLoggedIn`
 * signs in as before — the injection is best-effort and never fatal.
 */
import type { BrowserContext } from "playwright";
import { config } from "./config.js";
import { loadCookies, type Cookie } from "./http-client.js";

export interface InjectableCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

/** Safety margin so we never inject a cookie that dies mid-run. */
export const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

/**
 * Pick the cookies worth injecting at `now`.
 *
 * Dropped:
 * - session cookies (`expires <= 0`) — these come from the persistent-profile
 *   store, not a portable snapshot, and are meaningless across runs;
 * - cookies that expire within `EXPIRY_MARGIN_MS` — they would logout mid-run;
 * - malformed entries without a name, value, or domain.
 *
 * Pure so the filtering rules are unit-testable without a browser.
 */
export function selectInjectableCookies(
  cookies: readonly Cookie[],
  now: number,
  marginMs = EXPIRY_MARGIN_MS,
): InjectableCookie[] {
  const out: InjectableCookie[] = [];
  const seen = new Set<string>();
  for (const cookie of cookies) {
    if (!cookie || !cookie.name || cookie.value === undefined || cookie.value === "") continue;
    if (!cookie.domain) continue;
    const expires = typeof cookie.expires === "number" ? cookie.expires : 0;
    if (expires <= 0) continue; // session cookie — not portable
    if (expires * 1000 - now <= marginMs) continue; // about to expire

    const key = `${cookie.domain}\u0000${cookie.path || "/"}\u0000${cookie.name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const injectable: InjectableCookie = {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || "/",
      expires,
    };
    if (cookie.httpOnly) injectable.httpOnly = true;
    if (cookie.secure) injectable.secure = true;
    if (cookie.sameSite) injectable.sameSite = cookie.sameSite;
    out.push(injectable);
  }
  return out;
}

export interface SessionRestoreResult {
  injected: number;
  skipped: number;
  error?: string;
}

/**
 * Inject the saved session into a freshly launched context. Never throws:
 * a missing/corrupt state file or a rejected cookie must fall through to the
 * normal sign-in path rather than fail the run.
 */
export async function restoreSavedSession(
  context: BrowserContext,
  options: { now?: number; statePath?: string } = {},
): Promise<SessionRestoreResult> {
  let cookies: Cookie[];
  try {
    cookies = await loadCookies(options.statePath ?? config.sessionStatePath);
  } catch (error) {
    return { injected: 0, skipped: 0, error: (error as Error).message };
  }

  const selected = selectInjectableCookies(cookies, options.now ?? Date.now());
  if (selected.length === 0) return { injected: 0, skipped: cookies.length };

  try {
    await context.addCookies(selected);
    return { injected: selected.length, skipped: cookies.length - selected.length };
  } catch (error) {
    return { injected: 0, skipped: cookies.length, error: (error as Error).message };
  }
}
