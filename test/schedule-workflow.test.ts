import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { schedulerCalendarTimes } from "../src/schedule-window.js";

/**
 * The scheduled GitHub Actions workflow hardcodes a UTC cron line, while the
 * app reasons in IST (schedule-window.ts is the single source of truth). This
 * test reads the workflow file and proves its cron still fires at exactly the
 * scheduler's IST times, so the YAML cannot silently drift from the code.
 */
const WORKFLOW_PATH = ".github/workflows/scheduled.yml";

/** IST is UTC+5:30 all year (India has no DST), so conversion is fixed. */
function istFromUtc(hour: number, minute: number): { hour: number; minute: number } {
  const totalMinutes = hour * 60 + minute + 5 * 60 + 30;
  return { hour: Math.floor(totalMinutes / 60) % 24, minute: totalMinutes % 60 };
}

/** Extract the cron expression from the workflow file. */
function workflowCron(): string {
  const yaml = readFileSync(WORKFLOW_PATH, "utf8");
  const match = yaml.match(/^\s*-\s*cron:\s*"([^"]+)"/m);
  assert.ok(match, `No cron line found in ${WORKFLOW_PATH}`);
  return match[1];
}

test("scheduled workflow: cron IST times match schedule-window.ts", () => {
  const fields = workflowCron().trim().split(/\s+/);
  assert.equal(fields.length, 5, `cron must have 5 fields: "${workflowCron()}"`);
  const [minuteField, hourField] = fields;

  const fired = hourField
    .split(",")
    .flatMap((hour) => minuteField.split(",").map((minute) => istFromUtc(Number(hour), Number(minute))))
    .sort((a, b) => a.hour - b.hour || a.minute - b.minute);

  const expected = schedulerCalendarTimes().sort((a, b) => a.hour - b.hour || a.minute - b.minute);
  assert.deepEqual(fired, expected);
});

test("scheduled workflow: cron covers weekdays only (Mon-Fri)", () => {
  const weekdayField = workflowCron().trim().split(/\s+/)[4];
  assert.equal(weekdayField, "1-5");
});

test("scheduled workflow: runs the IST-window entry and never cancels an in-flight run", () => {
  const yaml = readFileSync(WORKFLOW_PATH, "utf8");
  assert.match(yaml, /run:\s*npm run scheduled/m, "must invoke the scheduled entry, not a raw download");
  assert.match(yaml, /cancel-in-progress:\s*false/m, "runs must queue, never cancel mid-download");
});
