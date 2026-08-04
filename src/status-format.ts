import { DownloadStore } from "./store.js";
import { nextRunInfo } from "./schedule-window.js";
import { dateInIndia, indiaTime } from "./utils.js";

export interface StatusSummary {
  total: number;
  thisWeek: number;
  thisMonth: number;
  lastRun: string;
  ranToday: boolean;
  failureRate: number;
  failedRuns: number;
  recentRunCount: number;
  consecutiveFailures: number;
  transport: string;
  nextRun: string;
}

const WEEK_MS = 7 * 86_400_000;

/** Shared summary computation used by both the CLI and the Telegram bot. */
export function summarize(store: DownloadStore): StatusSummary {
  const data = store.snapshot();
  const records = data.records ?? [];

  const lastRun = data.lastSuccessfulRunAt;
  const ranToday = lastRun ? dateInIndia(new Date(lastRun)) === dateInIndia() : false;
  const lastRunStr = lastRun
    ? `${dateInIndia(new Date(lastRun))}${ranToday ? " (today)" : ""}`
    : "never";

  const weekAgo = Date.now() - WEEK_MS;
  const thisWeek = records.filter((r) => new Date(r.downloadedAt).getTime() > weekAgo).length;

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const thisMonth = records.filter((r) => new Date(r.downloadedAt).getTime() > monthStart.getTime()).length;

  const recentRuns = (data.runs ?? []).slice(-20);
  const failedRuns = recentRuns.filter((r) => r.outcome === "failure" || r.outcome === "needs_login").length;
  const failureRate = recentRuns.length > 0 ? Math.round((failedRuns / recentRuns.length) * 100) : 0;

  return {
    total: records.length,
    thisWeek,
    thisMonth,
    lastRun: lastRunStr,
    ranToday,
    failureRate,
    failedRuns,
    recentRunCount: recentRuns.length,
    consecutiveFailures: data.consecutiveFailures || 0,
    transport: data.lastTransport || "unknown",
    nextRun: nextRunInfo(indiaTime()),
  };
}

/** Plain-text renderer for the CLI (`npm run status -- --summary`). */
export function formatStatusPlain(summary: StatusSummary): string {
  return [
    `📸 Total: ${summary.total} | This week: ${summary.thisWeek} | This month: ${summary.thisMonth}`,
    `✅ Last run: ${summary.lastRun} | Failures: ${summary.failureRate}% (${summary.consecutiveFailures} streak)`,
    `🔧 Transport: ${summary.transport} | Next: ${summary.nextRun}`,
  ].join("\n");
}

/** HTML renderer for Telegram. */
export function formatStatusHtml(summary: StatusSummary): string {
  return [
    "<b>School Photos Status</b>",
    "",
    `Total: ${summary.total}`,
    `This week: ${summary.thisWeek}`,
    `This month: ${summary.thisMonth}`,
    `Last run: ${summary.lastRun}`,
    `Failure rate: ${summary.failureRate}% (${summary.consecutiveFailures} streak)`,
    `Transport: ${summary.transport}`,
    `Next run: ${summary.nextRun}`,
  ].join("\n");
}
