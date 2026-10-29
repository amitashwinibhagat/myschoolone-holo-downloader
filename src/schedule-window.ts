/**
 * Schedule reasoning, in IST (`Asia/Kolkata`).
 *
 * This file stays the single source of truth for *when* the scheduler fires:
 * `schedulerCalendarTimes()` is read by the LaunchAgent installers and pinned
 * to the GitHub Actions cron by `test/schedule-workflow.test.ts`.
 *
 * The runtime decision, however, is derived from staleness rather than from the
 * clock hour. GitHub's cron is best-effort and drifts badly: over the last 25
 * scheduled runs, 12 exited as "outside schedule window" — one arriving at
 * 01:43 IST (+4h43m), and one reconcile landing at 22:05 IST and being thrown
 * away because `hour === 22` was outside 13–20. Deciding "is the index stale?"
 * instead of "is it exactly 15:00?" turns those discarded runs into real work
 * while keeping a night guard so nothing runs at 3am.
 */

export interface ScheduleClock {
  weekday: number;
  hour: number;
  minute: number;
}

export type ScheduleMode = "fast" | "reconcile";

/**
 * Window in which a non-overdue run may start (IST hours, inclusive start,
 * exclusive end). Quiet hours only suppress runs that are not genuinely
 * overdue — see `decideDue`.
 */
export const RUN_WINDOW = { startHour: 6, endHour: 23 } as const;

/** A successful run this recent means the index is fresh — nothing to do. */
export const FRESH_AFTER_MS = 4 * 60 * 60 * 1000;

/** Past this age, take the full lookback sweep rather than a single day. */
export const RECONCILE_AFTER_MS = 20 * 60 * 60 * 1000;

export function schedulerCalendarTimes(): Array<{ hour: number; minute: number }> {
  return [
    { hour: 15, minute: 0 },
    { hour: 21, minute: 0 },
  ];
}

function hourLabel(hour: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}${hour >= 12 ? "PM" : "AM"}`;
}

/** Human-readable description of the next scheduled run, given IST clock parts. */
export function nextRunInfo(clock: ScheduleClock): string {
  const isWeekday = clock.weekday >= 1 && clock.weekday <= 5;
  const times = schedulerCalendarTimes().map((t) => hourLabel(t.hour));
  const next = schedulerCalendarTimes().find(
    (t) => clock.hour < t.hour || (clock.hour === t.hour && clock.minute < t.minute),
  );
  if (!isWeekday) return `next weekday ${times.join(" & ")} IST`;
  return next ? `today ${hourLabel(next.hour)} IST` : `next weekday ${times.join(" & ")} IST`;
}

/** True when the IST clock is inside the window where an overdue run may start. */
export function isWithinRunWindow(clock: ScheduleClock): boolean {
  return clock.hour >= RUN_WINDOW.startHour && clock.hour < RUN_WINDOW.endHour;
}

export type DueDecision =
  | { run: false; reason: "weekend" | "outside_window" | "fresh" }
  | { run: true; mode: ScheduleMode; ageMs: number | undefined };

/**
 * Decide whether a scheduled fire should do work.
 *
 * The ordering matters:
 * - `force` bypasses every guard (shadow run / manual recovery).
 * - A genuinely overdue index runs whenever the cron fires, even at night: a
 *   missed sweep costs real coverage, which matters more than the hour.
 * - Otherwise the quiet-hours guard keeps runs out of the small hours, and a
 *   recent success is skipped so a drifted/duplicated cron fire is a no-op.
 *
 * `lastSuccessAt` missing/unparseable counts as "never ran" → reconcile.
 */
export function decideDue(
  clock: ScheduleClock,
  lastSuccessAt: string | undefined,
  now: number,
  options: { force?: boolean } = {},
): DueDecision {
  const parsed = lastSuccessAt ? Date.parse(lastSuccessAt) : NaN;
  const ageMs = Number.isNaN(parsed) ? undefined : now - parsed;
  const overdue = ageMs === undefined || ageMs >= RECONCILE_AFTER_MS;
  const modeFor = (): ScheduleMode => (overdue ? "reconcile" : "fast");

  if (options.force) return { run: true, mode: modeFor(), ageMs };

  // A long-overdue index overrides the quiet hours: skipping it would lose a
  // whole day's sweep just because the cron drifted hours late.
  if (!overdue && !isWithinRunWindow(clock)) return { run: false, reason: "outside_window" };

  if (ageMs !== undefined && ageMs < FRESH_AFTER_MS) return { run: false, reason: "fresh" };
  return { run: true, mode: modeFor(), ageMs };
}

/** Lookback for a mode: a fast poll only refreshes today; reconcile sweeps. */
export function lookbackForMode(mode: ScheduleMode, configuredLookback: number): number {
  return mode === "fast" ? 1 : configuredLookback;
}
