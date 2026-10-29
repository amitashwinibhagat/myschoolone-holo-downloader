import assert from "node:assert/strict";
import test from "node:test";
import {
  decideDue,
  FRESH_AFTER_MS,
  isWithinRunWindow,
  lookbackForMode,
  RECONCILE_AFTER_MS,
  schedulerCalendarTimes,
} from "../src/schedule-window.js";

const NOW = Date.parse("2026-10-28T12:00:00Z"); // 17:30 IST, a Wednesday

function hoursAgo(h: number): string {
  return new Date(NOW - h * 3_600_000).toISOString();
}

// --- calendar times stay the single source of truth ------------------------

test("creates exactly two calendar entries for 15:00 and 21:00", () => {
  const times = schedulerCalendarTimes();
  assert.equal(times.length, 2);
  assert.deepEqual(times[0], { hour: 15, minute: 0 });
  assert.deepEqual(times[1], { hour: 21, minute: 0 });
});

// --- the night guard -------------------------------------------------------

test("run window keeps runs out of the middle of the night", () => {
  assert.equal(isWithinRunWindow({ weekday: 3, hour: 5, minute: 59 }), false);
  assert.equal(isWithinRunWindow({ weekday: 3, hour: 6, minute: 0 }), true);
  assert.equal(isWithinRunWindow({ weekday: 3, hour: 22, minute: 59 }), true);
  assert.equal(isWithinRunWindow({ weekday: 3, hour: 23, minute: 0 }), false);
});

// --- staleness drives the decision ----------------------------------------

test("a never-run store is due for a reconcile", () => {
  const decision = decideDue({ weekday: 3, hour: 17, minute: 30 }, undefined, NOW);
  assert.deepEqual(decision, { run: true, mode: "reconcile", ageMs: undefined });
});

test("a fresh index is skipped even inside the window", () => {
  const decision = decideDue({ weekday: 3, hour: 17, minute: 30 }, hoursAgo(1), NOW);
  assert.equal(decision.run, false);
  assert.equal(decision.run === false && decision.reason, "fresh");
});

test("a stale index runs a fast poll before the reconcile horizon", () => {
  const decision = decideDue({ weekday: 3, hour: 17, minute: 30 }, hoursAgo(6), NOW);
  assert.deepEqual(decision, { run: true, mode: "fast", ageMs: FRESH_AFTER_MS + 2 * 3_600_000 });
});

test("a long-stale index escalates to a full reconcile", () => {
  const decision = decideDue({ weekday: 3, hour: 17, minute: 30 }, hoursAgo(25), NOW);
  assert.equal(decision.run, true);
  assert.equal(decision.run === true && decision.mode, "reconcile");
});

// --- the bug this replaced ------------------------------------------------

test("a drifted late run still works instead of being discarded", () => {
  // Regression: the 21:00 reconcile that actually fired at 22:05 IST used to
  // fail `hour === 21` and be skipped, losing that day's 7-day sweep.
  const decision = decideDue({ weekday: 3, hour: 22, minute: 5 }, hoursAgo(9), NOW);
  assert.equal(decision.run, true);
  assert.equal(decision.run === true && decision.mode, "fast");
});

test("a long-drifted overnight run is not lost to the quiet-hours guard", () => {
  // Regression: the 21:00 reconcile landed at 01:43 IST (+4h43m) and the old
  // hour check discarded it. Genuine staleness now outranks the hour.
  const decision = decideDue({ weekday: 3, hour: 1, minute: 43 }, hoursAgo(25), NOW);
  assert.equal(decision.run, true);
  assert.equal(decision.run === true && decision.mode, "reconcile");
});

test("the quiet-hours guard still suppresses a non-overdue night run", () => {
  const decision = decideDue({ weekday: 3, hour: 2, minute: 0 }, hoursAgo(9), NOW);
  assert.equal(decision.run, false);
  assert.equal(decision.run === false && decision.reason, "outside_window");
});

test("an unparseable lastSuccessAt is treated as never-ran", () => {
  const decision = decideDue({ weekday: 3, hour: 17, minute: 30 }, "not-a-date", NOW);
  assert.equal(decision.run, true);
  assert.equal(decision.run === true && decision.mode, "reconcile");
});

// --- force bypasses the guards --------------------------------------------

test("force overrides the night guard", () => {
  const decision = decideDue({ weekday: 0, hour: 3, minute: 0 }, hoursAgo(0.1), NOW, { force: true });
  assert.equal(decision.run, true);
});

test("force still picks reconcile when the index is genuinely stale", () => {
  const decision = decideDue({ weekday: 0, hour: 3, minute: 0 }, hoursAgo(30), NOW, { force: true });
  assert.equal(decision.run === true && decision.mode, "reconcile");
});

test("weekends are no longer blanket-skipped", () => {
  const decision = decideDue({ weekday: 6, hour: 15, minute: 0 }, hoursAgo(9), NOW);
  assert.equal(decision.run, true);
});
// --- lookback -------------------------------------------------------------

test("lookback: fast polls one day, reconcile sweeps the configured window", () => {
  assert.equal(lookbackForMode("fast", 7), 1);
  assert.equal(lookbackForMode("reconcile", 7), 7);
});

test("reconcile horizon is past the fresh horizon", () => {
  assert.ok(RECONCILE_AFTER_MS > FRESH_AFTER_MS);
});
