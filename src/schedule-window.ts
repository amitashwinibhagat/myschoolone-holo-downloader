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
  const times: Array<{ hour: number; minute: number }> = [];
  for (let hour = 13; hour <= 20; hour += 1) {
    for (const minute of [0, 10, 20, 30, 40, 50]) times.push({ hour, minute });
  }
  times.push({ hour: 21, minute: 0 });
  return times;
}
