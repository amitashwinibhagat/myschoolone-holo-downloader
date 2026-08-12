import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DownloadStore, type DownloadRecord, type RunRecord } from "../src/store.js";
import { summarize, formatStatusPlain, formatStatusHtml } from "../src/status-format.js";

// status-format imports only schedule-window + utils (no config), so no env is needed.

function record(hash: string, downloadedAt: string): DownloadRecord {
  return { hash, filename: `${hash}.jpg`, savedPath: `/tmp/${hash}.jpg`, downloadedAt };
}

test("summarize: computes totals, this-week/this-month counts and transport", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "myschoolone-summary-"));
  try {
    const store = new DownloadStore(dir);
    await store.load();
    // Fixed reference time so the assertions are deterministic (the Mac's
    // timezone must not influence the result). 2026-08-15T12:00Z = 17:30 IST.
    const now = Date.parse("2026-08-15T12:00:00Z");
    store.add(record("today", "2026-08-15T10:00:00Z")); // this week, this month
    store.add(record("three-days-ago", "2026-08-12T10:00:00Z")); // this week, this month
    // 2026-07-31T20:00Z is 2026-08-01 01:30 IST — August in IST, July in most
    // other timezones. It must count toward this month.
    store.add(record("ist-boundary", "2026-07-31T20:00:00Z"));
    store.add(record("two-months-ago", "2026-06-15T10:00:00Z"));
    await store.recordRun({
      startedAt: "2026-08-15T09:00:00Z",
      finishedAt: "2026-08-15T09:30:00Z",
      source: "scheduled",
      mode: "reconcile",
      transport: "direct",
      outcome: "success",
      saved: 3,
      duplicates: 0,
      failures: 0,
      daysChecked: 7,
    });

    const summary = summarize(store, now);
    assert.equal(summary.total, 4);
    assert.equal(summary.thisWeek, 2);
    assert.equal(summary.thisMonth, 3);
    assert.equal(summary.transport, "direct");
    assert.equal(summary.ranToday, true);
    assert.equal(summary.failureRate, 0);
    assert.equal(summary.consecutiveFailures, 0); // last run succeeded
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("summarize: needs_login counts as a failed run for the failure rate", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "myschoolone-summary-"));
  try {
    const store = new DownloadStore(dir);
    await store.load();
    await store.recordRun({
      startedAt: "2026-08-01T15:00:00Z",
      finishedAt: "2026-08-01T15:01:00Z",
      source: "scheduled",
      mode: "reconcile",
      transport: "browser",
      outcome: "needs_login",
      saved: 0,
      duplicates: 0,
      failures: 1,
      daysChecked: 0,
      error: "login",
    });
    const summary = summarize(store);
    assert.equal(summary.failureRate, 100);
    assert.equal(summary.consecutiveFailures, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("formatStatusPlain and formatStatusHtml render the summary", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "myschoolone-summary-"));
  try {
    const store = new DownloadStore(dir);
    await store.load();
    store.add(record("a", new Date().toISOString()));
    await store.flush();
    const summary = summarize(store);

    const plain = formatStatusPlain(summary);
    assert.ok(plain.includes("Total: 1"));
    assert.ok(plain.includes("Transport"));

    const html = formatStatusHtml(summary);
    assert.ok(html.includes("<b>School Photos Status</b>"));
    assert.ok(html.includes("Total: 1"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
