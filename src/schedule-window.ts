export interface ScheduleClock {
  weekday: number;
  hour: number;
  minute: number;
}

export function modeForClock(clock: ScheduleClock): "fast" | "reconcile" | undefined {
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
