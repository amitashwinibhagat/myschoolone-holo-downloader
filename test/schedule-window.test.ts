import assert from "node:assert/strict";
import test from "node:test";
import { modeForClock, schedulerCalendarTimes } from "../src/schedule-window.js";

test("selects fast polling only in the weekday 13:00-20:59 window", () => {
  assert.equal(modeForClock({ weekday: 3, hour: 12, minute: 59 }), undefined);
  assert.equal(modeForClock({ weekday: 3, hour: 13, minute: 0 }), "fast");
  assert.equal(modeForClock({ weekday: 3, hour: 20, minute: 50 }), "fast");
  assert.equal(modeForClock({ weekday: 3, hour: 21, minute: 0 }), "reconcile");
  assert.equal(modeForClock({ weekday: 3, hour: 21, minute: 59 }), "reconcile");
  assert.equal(modeForClock({ weekday: 3, hour: 22, minute: 0 }), undefined);
  assert.equal(modeForClock({ weekday: 6, hour: 15, minute: 0 }), undefined);
});

test("creates exactly two calendar entries for 15:00 and 21:00", () => {
  const times = schedulerCalendarTimes();
  assert.equal(times.length, 2);
  assert.deepEqual(times[0], { hour: 15, minute: 0 });
  assert.deepEqual(times[1], { hour: 21, minute: 0 });
});
