/**
 * Cloudflare interstitial markers, shared by the browser detector and the
 * raw-HTTP session check.
 *
 * These were duplicated: `session.ts` carried four markers while `browser.ts`
 * carried seven, the extra three added after a real cloud failure where the
 * managed challenge's *body* text differed from its title. The raw-HTTP check
 * could therefore classify a managed challenge as "ok" and send the direct
 * path straight into an interstitial. One list keeps the two from disagreeing.
 */

/**
 * Text that identifies a challenge interstitial. Matched case-insensitively
 * against a page title, page body, or raw HTTP body. Deliberately specific:
 * "Just a moment" and friends are Cloudflare's own wording, not generic portal
 * copy, so false positives stay unlikely.
 */
export const CHALLENGE_MARKERS = [
  "Verifying you are human",
  "Just a moment",
  "Checking your browser",
  "needs to review the security of your connection",
  // Managed-challenge body text (captured from a real cloud-run failure): the
  // title reads "Just a moment..." but the body uses these instead.
  "Performing security verification",
  "verifies you are not a bot",
  "Enable JavaScript and cookies",
] as const;

/** True when `text` contains any known challenge marker (case-insensitive). */
export function looksLikeChallenge(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));
}
