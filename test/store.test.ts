import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DownloadStore, type DownloadRecord, type RunRecord } from "../src/store.js";

test("DownloadStore: loads from empty state", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "myschoolone-store-"));
  try {
    const store = new DownloadStore(dir);
    await store.load();
    const data = store.snapshot();
    assert.deepEqual(data.records, []);
    assert.deepEqual(data.runs, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("DownloadStore: persists and reloads records", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "myschoolone-store-"));
  try {
    const store1 = new DownloadStore(dir);
    await store1.load();
    store1.add({
      hash: "abc123",
      sourceUrl: "https://example.com/photo.jpg",
      filename: "abc123-photo.jpg",
      savedPath: "/tmp/photo.jpg",
      downloadedAt: "2026-07-29T10:00:00Z",
    });
    await store1.save();

    const store2 = new DownloadStore(dir);
    await store2.load();
    const data = store2.snapshot();
    assert.equal(data.records.length, 1);
    assert.equal(data.records[0].hash, "abc123");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("DownloadStore: hasHash detects duplicates", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "myschoolone-store-"));
  try {
    const store = new DownloadStore(dir);
    await store.load();
    assert.equal(store.hasHash("abc123"), false);
    store.add({
      hash: "abc123",
      filename: "test.jpg",
      savedPath: "/tmp/test.jpg",
      downloadedAt: "2026-07-29T10:00:00Z",
    });
    assert.equal(store.hasHash("abc123"), true);
    assert.equal(store.hasHash("def456"), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("DownloadStore: records runs and tracks metadata", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "myschoolone-store-"));
  try {
    const store = new DownloadStore(dir);
    await store.load();

    const run: RunRecord = {
      startedAt: "2026-07-29T15:00:00Z",
      finishedAt: "2026-07-29T15:01:00Z",
      source: "scheduled",
      mode: "reconcile",
      transport: "direct",
      outcome: "success",
      saved: 5,
      duplicates: 2,
      failures: 0,
      daysChecked: 7,
    };
    await store.recordRun(run);

    const data = store.snapshot();
    assert.equal(data.runs?.length, 1);
    assert.equal(data.lastSuccessfulRunAt, "2026-07-29T15:01:00Z");
    assert.equal(data.lastTransport, "direct");
    assert.equal(data.consecutiveFailures, 0);
    assert.equal(data.lastNewPhotosAt, "2026-07-29T15:01:00Z");
    assert.equal(data.lastReconciliationAt, "2026-07-29T15:01:00Z");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("DownloadStore: tracks consecutive failures", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "myschoolone-store-"));
  try {
    const store = new DownloadStore(dir);
    await store.load();

    await store.recordRun({
      startedAt: "2026-07-29T15:00:00Z",
      finishedAt: "2026-07-29T15:01:00Z",
      source: "scheduled",
      mode: "reconcile",
      transport: "browser",
      outcome: "failure",
      saved: 0,
      duplicates: 0,
      failures: 1,
      daysChecked: 0,
      error: "Login expired",
    });
    assert.equal(store.snapshot().consecutiveFailures, 1);

    await store.recordRun({
      startedAt: "2026-07-29T21:00:00Z",
      finishedAt: "2026-07-29T21:01:00Z",
      source: "scheduled",
      mode: "reconcile",
      transport: "browser",
      outcome: "failure",
      saved: 0,
      duplicates: 0,
      failures: 1,
      daysChecked: 0,
      error: "Login expired",
    });
    assert.equal(store.snapshot().consecutiveFailures, 2);

    // Success resets the streak
    await store.recordRun({
      startedAt: "2026-07-30T15:00:00Z",
      finishedAt: "2026-07-30T15:01:00Z",
      source: "scheduled",
      mode: "reconcile",
      transport: "browser",
      outcome: "success",
      saved: 3,
      duplicates: 0,
      failures: 0,
      daysChecked: 7,
    });
    assert.equal(store.snapshot().consecutiveFailures, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("DownloadStore: caps run history at 300", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "myschoolone-store-"));
  try {
    const store = new DownloadStore(dir);
    await store.load();

    // Add 310 runs
    for (let i = 0; i < 310; i++) {
      await store.recordRun({
        startedAt: new Date(Date.now() + i * 1000).toISOString(),
        finishedAt: new Date(Date.now() + (i + 1) * 1000).toISOString(),
        source: "scheduled",
        mode: "reconcile",
        transport: "browser",
        outcome: "success",
        saved: 1,
        duplicates: 0,
        failures: 0,
        daysChecked: 1,
      });
    }

    const data = store.snapshot();
    assert.equal(data.runs?.length, 300);
    // First run should be the 11th (310 - 300 = 10 trimmed from the front)
    assert.ok(data.runs![0].startedAt > "2026-01-01");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
