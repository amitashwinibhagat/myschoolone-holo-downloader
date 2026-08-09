import assert from "node:assert/strict";
import test from "node:test";
import type { DirectPollOutcome } from "../src/direct-api.js";
import type { RunTotals } from "../src/run-download.js";

// run-download.ts imports config, so env must be present before the module loads.
process.env.HAI_API_KEY = "test-key";
process.env.SCHOOL_URL = "https://school.example.com";
process.env.STATE_DIR = "/nonexistent-dir-for-test";

const { directNeedsFallback } = await import("../src/run-download.js");

function outcome(overrides: Partial<DirectPollOutcome> = {}): DirectPollOutcome {
  return {
    results: [],
    discoveryUsed: false,
    discoveryFresh: false,
    discoveryComplete: false,
    ...overrides,
  };
}

function totals(overrides: Partial<RunTotals> = {}): RunTotals {
  return { saved: 0, duplicates: 0, failures: [], daysChecked: 0, ...overrides };
}

test("directNeedsFallback: any fetch-level error triggers a browser fallback", () => {
  assert.equal(
    directNeedsFallback(
      totals({ saved: 3, duplicates: 0, daysChecked: 2 }),
      outcome({ results: [{ urls: [], dateLabel: "x", error: "HTTP 500" }] }),
      1,
    ),
    true,
  );
});

test("directNeedsFallback: saved or duplicate URLs mean the direct result is trusted", () => {
  assert.equal(directNeedsFallback(totals({ saved: 1, daysChecked: 1 }), outcome(), 0), false);
  assert.equal(directNeedsFallback(totals({ duplicates: 2, daysChecked: 1 }), outcome(), 0), false);
});

test("directNeedsFallback: an all-empty window always falls back once, even with fresh discovery", () => {
  // A stale captured `type` value could otherwise silently hide real photos.
  assert.equal(directNeedsFallback(totals({ daysChecked: 7 }), outcome(), 0), true);
  assert.equal(
    directNeedsFallback(
      totals({ daysChecked: 7 }),
      outcome({ discoveryUsed: true, discoveryFresh: true, discoveryComplete: true }),
      0,
    ),
    true,
  );
});

test("directNeedsFallback: individual download failures do not force a fallback when URLs were found", () => {
  assert.equal(
    directNeedsFallback(totals({ saved: 1, failures: ["one bad url"], daysChecked: 2 }), outcome(), 0),
    false,
  );
});
