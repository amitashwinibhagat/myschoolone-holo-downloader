import type { RunMode } from "./store.js";

export interface ScheduleClock {
  weekday: number;
  hour: number;
  minute: number;
}

export function modeForClock(clock: ScheduleClock): Exclude<RunMode, "manual"> | undefined {
  if (clock.weekday < 1 || clock.weekday > 5) return undefined;
  if (clock.hour >= 13 && clock.hour < 21) return "fast";
  if (clock.hour === 21) return "reconcile";
  return undefined;
}

export function schedulerCalendarTimes(): Array<{ hour: number; minute: number }> {
  return [
    { hour: 15, minute: 0 },
    { hour: 21, minute: 0 },
  ];
}
