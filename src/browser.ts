import { chromium, type BrowserContext, type Page } from "playwright";
import { config } from "./config.js";
import { DownloadManager } from "./downloads.js";
import { acquireRunLock } from "./run-lock.js";
import { DownloadStore, type RunMode, type RunSource } from "./store.js";

export interface BrowserSession {
  context: BrowserContext;
  getPage: () => Page;
}

/**
 * Pick the page to drive: the active one while it is open, otherwise the
 * first still-open page (e.g. the main page after a popup closed). Only when
 * every page is closed is the dead active page returned, so the caller fails
 * with Playwright's own clear error instead of acting on the wrong target.
 * Pure (takes plain page handles) so it can be unit-tested without a browser.
 */
export function resolveActivePage(pages: Page[], active: Page): Page {
  if (!active.isClosed()) return active;
  return pages.find((page) => !page.isClosed()) ?? active;
}

// Fallback UA only used when the real Google Chrome channel is unavailable.
// Kept intentionally close to the bundled Chromium major version so the UA
// string stays consistent with the browser's actual JS engine / client hints.
const FALLBACK_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--no-default-browser-check",
  "--no-first-run",
  "--disable-features=IsolateOrigins,site-per-process,Translate",
  "--disable-infobars",
  "--disable-dev-shm-usage",
];

function buildOptions(channel?: string) {
  const options: Parameters<typeof chromium.launchPersistentContext>[1] = {
    headless: config.headless,
    viewport: { width: config.viewportWidth, height: config.viewportHeight },
    deviceScaleFactor: 1,
    acceptDownloads: true,
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
    // Prevent Playwright from advertising itself as automated.
    ignoreDefaultArgs: ["--enable-automation"],
    args: LAUNCH_ARGS,
  };

  if (channel) {
    // A real installed browser (Chrome/Edge) ships a native, self-consistent
    // user-agent + client hints, which is the single most effective way to
    // clear Cloudflare's challenge.
    options.channel = channel;
  } else {
    // Bundled Chromium: supply a UA that matches its real major version so the
    // UA string, Sec-CH-UA headers and navigator.userAgentData stay consistent.
    options.userAgent = FALLBACK_UA;
  }

  return options;
}

async function launchContext(): Promise<BrowserContext> {
  // Explicit "chromium" forces the bundled browser. Any other explicit value is
  // treated as a real browser channel. The default tries Chrome then Edge, both
  // of which evade Cloudflare far better than bundled Chromium.
  const configured = config.browserChannel;
  const candidates =
    configured === "chromium"
      ? []
      : configured
        ? [configured]
        : ["chrome", "msedge"];

  for (const channel of candidates) {
    try {
      const context = await chromium.launchPersistentContext(config.profileDir, buildOptions(channel));
      console.log(`Launched real browser channel: ${channel}`);
      return context;
    } catch (error) {
      console.warn(`Could not launch "${channel}" (${(error as Error).message}).`);
    }
  }

  if (candidates.length > 0) {
    console.warn(
      "Falling back to Playwright's bundled Chromium, which is more likely to hit " +
        "Cloudflare bot checks. Install Google Chrome for the most reliable behaviour.",
    );
  }

  return chromium.launchPersistentContext(config.profileDir, buildOptions(undefined));
}

export async function launchBrowser(downloadManager: DownloadManager): Promise<BrowserSession> {
  const context = await launchContext();

  // Minimal, consistent masking only. With a REAL browser (Chrome/Edge) plus the
  // --disable-blink-features=AutomationControlled flag, the fingerprint is already
  // authentic. Aggressively faking navigator.plugins / deviceMemory / a synthetic
  // window.chrome on a real browser INTRODUCES inconsistencies that Cloudflare
  // flags as a bot. So we only hide the webdriver tell and keep everything else real.
  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    } catch {
      /* ignore */
    }
  });

  let activePage = context.pages()[0] || (await context.newPage());

  const register = (page: Page): void => {
    activePage = page;
    page.on("download", (download) => void downloadManager.captureNativeDownload(download));
    page.on("popup", (popup) => register(popup));
  };

  for (const page of context.pages()) register(page);
  context.on("page", register);

  return { context, getPage: () => resolveActivePage(context.pages(), activePage) };
}

/**
 * Waits for a Cloudflare "Verifying you are human" interstitial to clear.
 * With a clean fingerprint the challenge usually passes automatically within a
 * few seconds; in headed mode the user can also solve it manually.
 */
export async function waitForHumanCheck(page: Page, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const markers = [
    "Verifying you are human",
    "Just a moment",
    "Checking your browser",
    "needs to review the security of your connection",
  ];

  while (Date.now() < deadline) {
    const text = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
    const challenged = markers.some((marker) => text.includes(marker));
    if (!challenged) return;
    console.log("Cloudflare human check detected — waiting for it to clear...");
    await page.waitForTimeout(2_500);
  }
}

export interface BrowserSessionContext {
  page: Page;
  browser: BrowserSession;
  downloads: DownloadManager;
  store: DownloadStore;
}

export interface WithBrowserOptions<T> {
  onLocked?: (owner?: { pid: number; startedAt: string; mode: RunMode; source: RunSource }) => Promise<T> | T;
}

/**
 * Execute an async operation with an exclusive browser session and run lock.
 * Automatically manages store loading, lock acquisition, browser launching,
 * context closing, and lock releasing.
 */
export async function withBrowserSession<T>(
  mode: RunMode,
  source: RunSource,
  fn: (session: BrowserSessionContext) => Promise<T>,
  options?: WithBrowserOptions<T>,
): Promise<T> {
  const store = new DownloadStore(config.stateDir);
  await store.load();
  const downloads = new DownloadManager(store);
  const lock = await acquireRunLock(config.stateDir, mode, source);
  if (!lock.acquired) {
    if (options?.onLocked) {
      return await options.onLocked(lock.owner);
    }
    throw new Error("Another downloader command is using the browser profile. Wait for it to finish.");
  }

  try {
    const browser = await launchBrowser(downloads);
    try {
      return await fn({ page: browser.getPage(), browser, downloads, store });
    } finally {
      await browser.context.close().catch(() => undefined);
    }
  } finally {
    await lock.release();
  }
}

