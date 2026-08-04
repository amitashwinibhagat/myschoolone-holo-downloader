import "dotenv/config";
import fs from "node:fs";
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

function boundedInteger(name: string, fallback: number, min: number, max: number): number {
  const value = integer(name, fallback);
  if (value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max} (got ${value}).`);
  }
  return value;
}

function enumValue<T extends string>(name: string, fallback: T, allowed: readonly T[]): T {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!allowed.includes(raw as T)) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")} (got "${raw}").`);
  }
  return raw as T;
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
  viewportWidth: boundedInteger("VIEWPORT_WIDTH", 1440, 640, 7680),
  viewportHeight: boundedInteger("VIEWPORT_HEIGHT", 1000, 480, 4320),
  maxSteps: boundedInteger("MAX_STEPS", 80, 1, 500),
  lookbackDays: boundedInteger("LOOKBACK_DAYS", 7, 1, 30),
  minApiIntervalMs: integer("MIN_API_INTERVAL_MS", 6500),
  minImageWidth: boundedInteger("MIN_IMAGE_WIDTH", 500, 50, 10000),
  minImageHeight: boundedInteger("MIN_IMAGE_HEIGHT", 350, 50, 10000),
  // Image compression (applied after dedupe, before writing to disk).
  compressImages: (process.env.COMPRESS_IMAGES?.trim() ?? "true").toLowerCase() !== "false",
  maxDimension: boundedInteger("MAX_DIMENSION", 2048, 128, 8192),
  jpegQuality: boundedInteger("JPEG_QUALITY", 82, 1, 100),
  // Telegram notifications (optional — falls back to macOS osascript).
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN?.trim() || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID?.trim() || "",
  healthcheckUrl: process.env.HEALTHCHECK_URL?.trim() || "",
  // AI mode: "auto" uses the Holo agent for complex navigation, "none" forces
  // deterministic-only operation (no screenshots sent to external APIs).
  aiMode: enumValue("AI_MODE", "auto", ["auto", "none"] as const),
  // Optional portal credentials for fully automatic re-login when the session
  // expires. When set, the deterministic path can sign back in without
  // depending on Chrome's (unreliable in automation) password autofill.
  // Stored in plaintext in .env — only use on a trusted, single-user machine.
  schoolUsername: process.env.SCHOOL_USERNAME?.trim() || "",
  schoolPassword: process.env.SCHOOL_PASSWORD || "",
  // Direct HTTP poll: set to false when the portal's AJAX endpoints are behind
  // a Cloudflare challenge that raw requests cannot pass (the downloader then
  // always uses the browser, which is the current default behaviour anyway).
  directPoll: (process.env.DIRECT_POLL?.trim() ?? "true").toLowerCase() !== "false",
};

// Warn early about a misconfigured download location so runs don't silently
// write somewhere unexpected.
if (!fs.existsSync(config.downloadDir)) {
  console.warn(`Warning: DOWNLOAD_DIR does not exist yet (${config.downloadDir}). It will be created on the first save.`);
}
