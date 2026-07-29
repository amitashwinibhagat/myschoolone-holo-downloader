import "dotenv/config";
import os from "node:os";
import path from "node:path";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
  return value;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) throw new Error(`${name} must be an integer.`);
  return value;
}

function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

const profileDir = path.resolve(expandHome(process.env.BROWSER_PROFILE_DIR?.trim() || ".browser-profile"));
const stateDir = path.resolve(expandHome(process.env.STATE_DIR?.trim() || ".state"));

export const config = {
  apiKey: required("HAI_API_KEY"),
  schoolUrl: required("SCHOOL_URL"),
  model: process.env.HOLO_MODEL?.trim() || "holo3-1-35b-a3b",
  downloadDir: path.resolve(expandHome(process.env.DOWNLOAD_DIR?.trim() || "~/Pictures/School Updates")),
  profileDir,
  stateDir,
  debugDir: path.join(stateDir, "debug"),
  sessionStatePath: path.join(stateDir, "browser-storage-state.json"),
  directDiscoveryPath: path.join(stateDir, "daily-log-discovery.json"),
  // Prefer a real installed browser to avoid Cloudflare bot challenges.
  // Empty default = auto-detect (tries Chrome, then Edge, then bundled Chromium).
  // Set BROWSER_CHANNEL=chromium to force Playwright's bundled Chromium.
  browserChannel: process.env.BROWSER_CHANNEL?.trim() || "",
  headless: process.env.HEADLESS?.toLowerCase() === "true",
  viewportWidth: integer("VIEWPORT_WIDTH", 1440),
  viewportHeight: integer("VIEWPORT_HEIGHT", 1000),
  maxSteps: integer("MAX_STEPS", 80),
  lookbackDays: integer("LOOKBACK_DAYS", 7),
  minApiIntervalMs: integer("MIN_API_INTERVAL_MS", 6500),
  minImageWidth: integer("MIN_IMAGE_WIDTH", 500),
  minImageHeight: integer("MIN_IMAGE_HEIGHT", 350),
  // Image compression (applied after dedupe, before writing to disk).
  compressImages: (process.env.COMPRESS_IMAGES?.trim() ?? "true").toLowerCase() !== "false",
  maxDimension: integer("MAX_DIMENSION", 2048),
  jpegQuality: integer("JPEG_QUALITY", 82),
  // Telegram notifications (optional — falls back to macOS osascript).
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN?.trim() || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID?.trim() || "",
  healthcheckUrl: process.env.HEALTHCHECK_URL?.trim() || "",
};
