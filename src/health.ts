/**
 * Portal health check: fingerprints the portal's structural elements and
 * compares against a known-good baseline. Detects DOM/API changes before
 * they break the downloader.
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

const FINGERPRINT_FILE = "portal-fingerprint.json";

interface PortalFingerprint {
  capturedAt: string;
  url: string;
  selectors: Record<string, string>;
  scripts: string[];
  endpoints: string[];
  hash: string;
}

interface HealthCheckResult {
  healthy: boolean;
  changed: boolean;
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
  await fs.writeFile(
    path.join(config.stateDir, FINGERPRINT_FILE),
    JSON.stringify(fingerprint, null, 2),
    { mode: 0o600 },
  );
}

/**
 * Compare two fingerprints and return what changed.
 */
function diffFingerprints(baseline: PortalFingerprint, current: PortalFingerprint): string[] {
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

/**
 * Run a full health check: capture fingerprint, compare to baseline.
 * If no baseline exists, capture and save one.
 */
export async function runHealthCheck(): Promise<HealthCheckResult> {
  const store = new DownloadStore(config.stateDir);
  await store.load();
  const downloads = new DownloadManager(store);
  const lock = await acquireRunLock(config.stateDir, "manual", "manual");
  if (!lock.acquired) {
    return { healthy: false, changed: false, message: "Cannot run health check — browser is locked by another process." };
  }

  try {
    const browser = await launchBrowser(downloads);
    try {
      const page = browser.getPage();
      const current = await captureFingerprint(page);
      const baseline = await loadBaseline();

      if (!baseline) {
        await saveBaseline(current);
        return {
          healthy: true,
          changed: false,
          message: `First run — baseline captured (hash: ${current.hash}). Future runs will compare against this.`,
          fingerprint: current,
        };
      }

      const changes = diffFingerprints(baseline, current);
      if (changes.length === 0) {
        return {
          healthy: true,
          changed: false,
          message: `Portal structure unchanged (hash: ${current.hash}).`,
          fingerprint: current,
        };
      }

      // Update baseline with the new fingerprint
      await saveBaseline(current);
      return {
        healthy: false,
        changed: true,
        message: `Portal structure changed:\n${changes.map((c) => `  - ${c}`).join("\n")}\nBaseline updated to hash: ${current.hash}`,
        fingerprint: current,
      };
    } finally {
      await browser.context.close().catch(() => undefined);
    }
  } catch (error) {
    return {
      healthy: false,
      changed: false,
      message: `Health check failed: ${(error as Error).message}`,
    };
  } finally {
    await lock.release();
  }
}

// CLI entry point
if (process.argv[1] && process.argv[1].includes("health")) {
  runHealthCheck()
    .then((result) => {
      console.log(`Healthy: ${result.healthy}`);
      console.log(`Changed: ${result.changed}`);
      console.log(`Message: ${result.message}`);
      process.exitCode = result.healthy ? 0 : 1;
    })
    .catch((error) => {
      console.error((error as Error).stack || (error as Error).message);
      process.exitCode = 1;
    });
}
