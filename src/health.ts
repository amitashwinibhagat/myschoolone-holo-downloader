/**
 * Portal health check: fingerprints the portal's structural elements and
 * compares against a known-good baseline. Detects DOM/API changes before
 * they break the downloader.
 *
 * The baseline is only replaced after two consecutive runs report the same
 * changed fingerprint, so a transient Cloudflare interstitial or maintenance
 * page never silently becomes the new baseline. The first change is reported
 * (and notified) while the old baseline is kept.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { config } from "./config.js";
import { launchBrowser, waitForHumanCheck } from "./browser.js";
import { DownloadManager } from "./downloads.js";
import { DownloadStore } from "./store.js";
import { acquireRunLock } from "./run-lock.js";
import { notify } from "./notify.js";
import { ensureLoggedIn, NeedsHumanLoginError } from "./portal.js";

const FINGERPRINT_FILE = "portal-fingerprint.json";

interface PortalFingerprint {
  capturedAt: string;
  url: string;
  selectors: Record<string, string>;
  scripts: string[];
  endpoints: string[];
  hash: string;
  /** A previously detected, not-yet-confirmed change. */
  pendingChange?: {
    hash: string;
    detectedAt: string;
    changes: string[];
  };
}

export interface HealthCheckResult {
  healthy: boolean;
  changed: boolean;
  /** True when the check could not run because the browser lock is held. */
  skipped?: boolean;
  message: string;
  fingerprint?: PortalFingerprint;
}

/**
 * Capture a structural fingerprint of the portal's Daily Log page.
 * This includes:
 * - Key DOM selectors (date picker, content area, sidebar)
 * - Inline script URLs and patterns
 * - AJAX endpoint patterns
 */
async function captureFingerprint(page: Page): Promise<PortalFingerprint> {
  const url = new URL("/Web/LearningManagement/daily_planner_parent.php", config.schoolUrl).toString();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(4_000);

  // Wait for Cloudflare if needed
  await waitForHumanCheck(page);

  const fingerprint = await page.evaluate(() => {
    const selectors: Record<string, string> = {};

    // Check for key DOM elements
    const dateInput = document.querySelector("#dailydate");
    if (dateInput) selectors.dailydate = dateInput.tagName + (dateInput.className ? `.${dateInput.className.split(" ")[0]}` : "");

    const sidebar = document.querySelector("[class*='sidebar'], [class*='menu'], nav");
    if (sidebar) selectors.sidebar = sidebar.tagName + (sidebar.className ? `.${sidebar.className.split(" ")[0]}` : "");

    const contentArea = document.querySelector("[class*='content'], [class*='main'], main");
    if (contentArea) selectors.contentArea = contentArea.tagName + (contentArea.className ? `.${contentArea.className.split(" ")[0]}` : "");

    // Check for tab-like navigation
    const tabs = document.querySelectorAll("[class*='tab'], [role='tab']");
    selectors.tabCount = String(tabs.length);

    // Collect script sources (external only)
    const scripts = Array.from(document.querySelectorAll("script[src]"))
      .map((s) => (s as HTMLScriptElement).src)
      .filter((src) => !src.includes("google") && !src.includes("analytics"))
      .slice(0, 10);

    // Look for AJAX endpoint patterns in inline scripts
    const inlineScripts = Array.from(document.querySelectorAll("script:not([src])"))
      .map((s) => s.textContent || "")
      .join("\n");

    const endpoints: string[] = [];
    const endpointPatterns = [
      /url\s*:\s*["']([^"']+)["']/gi,
      /\.ajax\s*\(\s*["']([^"']+)["']/gi,
      /fetch\s*\(\s*["']([^"']+)["']/gi,
    ];
    for (const pattern of endpointPatterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(inlineScripts)) !== null) {
        if (!endpoints.includes(match[1])) endpoints.push(match[1]);
      }
    }

    return { selectors, scripts: scripts.map((s) => s.split("/").pop() || s), endpoints: endpoints.slice(0, 10) };
  });

  const content = JSON.stringify(fingerprint.selectors) + JSON.stringify(fingerprint.scripts) + JSON.stringify(fingerprint.endpoints);
  const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);

  return {
    capturedAt: new Date().toISOString(),
    url,
    ...fingerprint,
    hash,
  };
}

/**
 * Load the saved baseline fingerprint.
 */
async function loadBaseline(): Promise<PortalFingerprint | null> {
  try {
    const raw = await fs.readFile(path.join(config.stateDir, FINGERPRINT_FILE), "utf8");
    return JSON.parse(raw) as PortalFingerprint;
  } catch {
    return null;
  }
}

/**
 * Save the current fingerprint as the new baseline.
 */
async function saveBaseline(fingerprint: PortalFingerprint): Promise<void> {
  await fs.mkdir(config.stateDir, { recursive: true });
  const temp = path.join(config.stateDir, `${FINGERPRINT_FILE}.tmp`);
  await fs.writeFile(temp, JSON.stringify(fingerprint, null, 2), { mode: 0o600 });
  await fs.rename(temp, path.join(config.stateDir, FINGERPRINT_FILE));
}

/**
 * Compare two fingerprints and return what changed.
 */
export function diffFingerprints(baseline: PortalFingerprint, current: PortalFingerprint): string[] {
  const changes: string[] = [];

  if (baseline.hash === current.hash) return [];

  // Compare selectors
  const baselineKeys = new Set(Object.keys(baseline.selectors));
  const currentKeys = new Set(Object.keys(current.selectors));
  for (const key of currentKeys) {
    if (!baselineKeys.has(key)) changes.push(`New selector: ${key} = ${current.selectors[key]}`);
    else if (baseline.selectors[key] !== current.selectors[key])
      changes.push(`Selector changed: ${key}: ${baseline.selectors[key]} → ${current.selectors[key]}`);
  }
  for (const key of baselineKeys) {
    if (!currentKeys.has(key)) changes.push(`Selector removed: ${key}`);
  }

  // Compare endpoints
  const baselineEndpoints = new Set(baseline.endpoints);
  const currentEndpoints = new Set(current.endpoints);
  for (const ep of currentEndpoints) {
    if (!baselineEndpoints.has(ep)) changes.push(`New endpoint: ${ep}`);
  }
  for (const ep of baselineEndpoints) {
    if (!currentEndpoints.has(ep)) changes.push(`Endpoint removed: ${ep}`);
  }

  // Compare script count
  if (baseline.scripts.length !== current.scripts.length) {
    changes.push(`Script count changed: ${baseline.scripts.length} → ${current.scripts.length}`);
  }

  return changes;
}

export type BaselineDecision =
  | { action: "first_capture" }
  | { action: "unchanged" }
  | { action: "recovered" }
  | { action: "accepted_change"; changes: string[] }
  | { action: "pending_change"; changes: string[] };

/**
 * Pure decision logic for the two-consecutive-change baseline rule:
 * - first capture → create baseline
 * - same fingerprint → unchanged (or "recovered" if a pending change existed)
 * - a changed fingerprint seen twice in a row → accepted as the new baseline
 * - any other change → pending (old baseline kept)
 */
export function decideBaseline(
  baseline: PortalFingerprint | null,
  current: PortalFingerprint,
  changes: string[],
): BaselineDecision {
  if (!baseline) return { action: "first_capture" };
  if (changes.length === 0) {
    return baseline.pendingChange ? { action: "recovered" } : { action: "unchanged" };
  }
  if (baseline.pendingChange && baseline.pendingChange.hash === current.hash) {
    return { action: "accepted_change", changes: baseline.pendingChange.changes };
  }
  return { action: "pending_change", changes };
}

/**
 * Run a full health check: capture fingerprint, compare to baseline.
 * - No baseline: capture and save one (first run).
 * - Same fingerprint: healthy. Any pending change is cleared (portal recovered).
 * - Different fingerprint, first sighting: keep the old baseline, notify, and
 *   remember the change as pending.
 * - Same different fingerprint seen twice in a row: accept it as the new
 *   baseline.
 */
export async function runHealthCheck(): Promise<HealthCheckResult> {
  const store = new DownloadStore(config.stateDir);
  await store.load();
  const downloads = new DownloadManager(store);
  const lock = await acquireRunLock(config.stateDir, "manual", "manual");
  if (!lock.acquired) {
    return { healthy: false, changed: false, skipped: true, message: "Cannot run health check — browser is locked by another process." };
  }

  try {
    const browser = await launchBrowser(downloads);
    try {
      const page = browser.getPage();
      // Ensure a logged-in session before fingerprinting: an expired session
      // would otherwise fingerprint the login page, and the two-consecutive
      // baseline rule could eventually accept it as the new baseline.
      await page.goto(config.schoolUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await ensureLoggedIn(page);
      const current = await captureFingerprint(page);
      const baseline = await loadBaseline();
      const changes = baseline ? diffFingerprints(baseline, current) : [];
      const decision = decideBaseline(baseline, current, changes);

      switch (decision.action) {
        case "first_capture":
          await saveBaseline(current);
          return {
            healthy: true,
            changed: false,
            message: `First run — baseline captured (hash: ${current.hash}). Future runs will compare against this.`,
            fingerprint: current,
          };
        case "unchanged":
          return {
            healthy: true,
            changed: false,
            message: `Portal structure unchanged (hash: ${current.hash}).`,
            fingerprint: current,
          };
        case "recovered": {
          const recovered: PortalFingerprint = { ...baseline! };
          delete recovered.pendingChange;
          await saveBaseline(recovered);
          return {
            healthy: true,
            changed: false,
            message: `Portal returned to the known baseline (hash: ${current.hash}) — pending change discarded.`,
            fingerprint: current,
          };
        }
        case "accepted_change": {
          const accepted: PortalFingerprint = { ...current };
          delete accepted.pendingChange;
          await saveBaseline(accepted);
          await notify(
            "School photos — PORTAL CHANGED (confirmed)",
            `The portal structure change was confirmed on a second run. The downloader now uses the new baseline. If downloads fail, run \`npm run login\`.\n${decision.changes.slice(0, 5).join("\n")}`,
          );
          return {
            healthy: false,
            changed: true,
            message:
              `Portal structure changed and confirmed twice:\n${decision.changes.map((c) => `  - ${c}`).join("\n")}\n` +
              `New baseline hash: ${current.hash}`,
            fingerprint: current,
          };
        }
        case "pending_change": {
          const pending: PortalFingerprint = {
            ...baseline!,
            pendingChange: { hash: current.hash, detectedAt: new Date().toISOString(), changes: decision.changes },
          };
          await saveBaseline(pending);
          await notify(
            "School photos — PORTAL CHANGED",
            `The portal structure changed. If downloads start failing, run \`npm run login\` and check \`npm run health\`.\n${decision.changes.slice(0, 5).join("\n")}`,
          );
          return {
            healthy: false,
            changed: true,
            message:
              `Portal structure changed (first sighting — baseline kept):\n${decision.changes.map((c) => `  - ${c}`).join("\n")}\n` +
              `Re-run health check to confirm and accept the new baseline.`,
            fingerprint: current,
          };
        }
      }
    } finally {
      await browser.context.close().catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof NeedsHumanLoginError) {
      return {
        healthy: false,
        changed: false,
        message: `Health check could not run — login required: ${(error as Error).message}`,
      };
    }
    return {
      healthy: false,
      changed: false,
      message: `Health check failed: ${(error as Error).message}`,
    };
  } finally {
    await lock.release();
  }
}
