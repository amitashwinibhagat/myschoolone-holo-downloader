import { DownloadStore } from "./store.js";
import { summarize, formatStatusHtml } from "./status-format.js";

export function formatStatus(store: DownloadStore): string {
  return formatStatusHtml(summarize(store));
}

export const helpText = [
  "<b>School Photos Bot</b>",
  "",
  "/run — Start a full photo download run",
  "/status — Show download summary",
  "/help — Show this help",
  "",
  "Only the configured chat can use these commands.",
].join("\n");
