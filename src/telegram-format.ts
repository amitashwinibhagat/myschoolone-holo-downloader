import { DownloadStore } from "./store.js";
import { dateInIndia, indiaTime } from "./utils.js";

export function formatStatus(store: DownloadStore): string {
  const data = store.snapshot();
  const records = data.records ?? [];

  const lastRun = data.lastSuccessfulRunAt;
  const ranToday = lastRun ? dateInIndia(new Date(lastRun)) === dateInIndia() : false;
  const lastRunStr = lastRun
    ? `${dateInIndia(new Date(lastRun))}${ranToday ? " (today)" : ""}`
    : "never";

  const weekAgo = Date.now() - 7 * 86_400_000;
  const thisWeek = records.filter((r) => new Date(r.downloadedAt).getTime() > weekAgo).length;

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const thisMonth = records.filter((r) => new Date(r.downloadedAt).getTime() > monthStart.getTime()).length;

  const recentRuns = (data.runs ?? []).slice(-20);
  const failedRuns = recentRuns.filter((r) => r.outcome === "failure").length;
  const failureRate = recentRuns.length > 0 ? Math.round((failedRuns / recentRuns.length) * 100) : 0;

  const clock = indiaTime();
  const weekday = clock.weekday >= 1 && clock.weekday <= 5;
  const nextRun = !weekday
    ? "next weekday 3PM IST"
    : clock.hour < 15
      ? "today 3PM IST"
      : clock.hour < 21
        ? "today 9PM IST"
        : "next weekday 3PM IST";

  const transport = data.lastTransport || "unknown";

  return [
    "<b>School Photos Status</b>",
    "",
    `Total: ${records.length}`,
    `This week: ${thisWeek}`,
    `This month: ${thisMonth}`,
    `Last run: ${lastRunStr}`,
    `Failure rate: ${failureRate}% (${data.consecutiveFailures || 0} streak)`,
    `Transport: ${transport}`,
    `Next run: ${nextRun}`,
  ].join("\n");
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
