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
  /** One-line next step so every status tells the user what to do (if anything). */
  action: string;
}

/** Derive the user's next step from recent run history. Pure — safe to unit-test. */
export function nextAction(runs: Array<{ outcome: string }>, consecutiveFailures: number): string {
  const last = runs[runs.length - 1];
  if (!last) return "Run `npm run daily` to fetch photos for the first time.";
  if (last.outcome === "needs_login") return "Run `npm run login` to restore the portal session.";
  if (consecutiveFailures >= 3) return "Multiple failures — run `npm run login`, then `npm run health`.";
  if (last.outcome === "failure") return "Last run failed — rerun; if it persists, run `npm run health`.";
  if (last.outcome === "skipped_locked") return "A run is in progress or a stale lock exists — wait a few minutes, then rerun.";
  return "All good — photos are flowing.";
}

const WEEK_MS = 7 * 86_400_000;

/** Shared summary computation used by both the CLI and the Telegram bot. */
export function summarize(store: DownloadStore, now = Date.now()): StatusSummary {
  const data = store.snapshot();
  const records = data.records ?? [];

  const lastRun = data.lastSuccessfulRunAt;
  const todayIso = dateInIndia(new Date(now));
  const ranToday = lastRun ? dateInIndia(new Date(lastRun)) === todayIso : false;
  const lastRunStr = lastRun
    ? `${dateInIndia(new Date(lastRun))}${ranToday ? " (today)" : ""}`
    : "never";

  const weekAgo = now - WEEK_MS;
  const thisWeek = records.filter((r) => new Date(r.downloadedAt).getTime() > weekAgo).length;

  // Month boundary in IST, matching the download-folder labels: the Mac's
  // local timezone may differ from Asia/Kolkata (e.g. the Mini set to UTC
  // would otherwise cut the month 5h30 early).
  const monthStart = Date.parse(`${todayIso.slice(0, 7)}-01T00:00:00+05:30`);
  const thisMonth = records.filter((r) => new Date(r.downloadedAt).getTime() >= monthStart).length;

  const recentRuns = (data.runs ?? []).slice(-20);
  const failedRuns = recentRuns.filter((r) => r.outcome === "failure" || r.outcome === "needs_login").length;
  const failureRate = recentRuns.length > 0 ? Math.round((failedRuns / recentRuns.length) * 100) : 0;
  const consecutiveFailures = data.consecutiveFailures || 0;

  return {
    total: records.length,
    thisWeek,
    thisMonth,
    lastRun: lastRunStr,
    ranToday,
    failureRate,
    failedRuns,
    recentRunCount: recentRuns.length,
    consecutiveFailures,
    transport: data.lastTransport || "unknown",
    nextRun: nextRunInfo(indiaTime(new Date(now))),
    action: nextAction(data.runs ?? [], consecutiveFailures),
  };
}

/** Plain-text renderer for the CLI (`npm run status -- --summary`). */
export function formatStatusPlain(summary: StatusSummary): string {
  return [
    `📸 Total: ${summary.total} | This week: ${summary.thisWeek} | This month: ${summary.thisMonth}`,
    `✅ Last run: ${summary.lastRun} | Failures: ${summary.failureRate}% (${summary.consecutiveFailures} streak)`,
    `🔧 Transport: ${summary.transport} | Next: ${summary.nextRun}`,
    `➡️ ${summary.action}`,
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
    `Next step: ${summary.action}`,
  ].join("\n");
}
