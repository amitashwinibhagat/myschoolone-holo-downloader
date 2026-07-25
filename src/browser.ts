import { chromium, type BrowserContext, type Page } from "playwright";
import { config } from "./config.js";
import { DownloadManager } from "./downloads.js";

export interface BrowserSession {
  context: BrowserContext;
  getPage: () => Page;
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

  return { context, getPage: () => activePage };
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
