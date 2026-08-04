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

test("DownloadStore: accepts telegram-sourced runs", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "myschoolone-store-"));
  try {
    const store = new DownloadStore(dir);
    await store.load();

    const run: RunRecord = {
      startedAt: "2026-07-29T18:00:00Z",
      finishedAt: "2026-07-29T18:01:00Z",
      source: "telegram",
      mode: "manual",
      transport: "browser",
      outcome: "success",
      saved: 2,
      duplicates: 1,
      failures: 0,
      daysChecked: 7,
    };
    await store.recordRun(run);

    const data = store.snapshot();
    assert.equal(data.runs?.length, 1);
    assert.equal(data.runs![0].source, "telegram");
    assert.equal(data.lastSuccessfulRunAt, "2026-07-29T18:01:00Z");
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

test("DownloadStore: add() is batched — no disk write until flush()", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "myschoolone-store-"));
  try {
    const store = new DownloadStore(dir);
    await store.load();
    store.add({
      hash: "batched-1",
      filename: "batched.jpg",
      savedPath: "/tmp/batched.jpg",
      downloadedAt: new Date().toISOString(),
    });
    // Nothing written yet
    const file = path.join(dir, "downloads.json");
    await assert.rejects(() => fs.readFile(file, "utf8"), { code: "ENOENT" });
    assert.equal(store.hasHash("batched-1"), true); // still visible in memory

    await store.flush();
    await assert.doesNotReject(() => fs.readFile(file, "utf8"));
    // A second flush with nothing new is a no-op and does not rewrite the file.
    await store.flush();
    const reloaded = new DownloadStore(dir);
    await reloaded.load();
    assert.equal(reloaded.snapshot().records.length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("DownloadStore: caps records at 10000 on save", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "myschoolone-store-"));
  try {
    const store = new DownloadStore(dir);
    await store.load();
    const now = Date.now();
    for (let i = 0; i < 10_100; i++) {
      store.add({
        hash: `hash-${i}`,
        filename: `${i}.jpg`,
        savedPath: `/tmp/${i}.jpg`,
        downloadedAt: new Date(now - i * 1000).toISOString(),
      });
    }
    assert.equal(store.snapshot().records.length, 10_100);
    await store.flush();
    assert.equal(store.snapshot().records.length, 10_000);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("DownloadStore: drops records older than the 12-month retention window", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "myschoolone-store-"));
  try {
    const store = new DownloadStore(dir);
    await store.load();
    const yearAgo = new Date(Date.now() - 400 * 86_400_000).toISOString();
    store.add({
      hash: "old",
      filename: "old.jpg",
      savedPath: "/tmp/old.jpg",
      downloadedAt: yearAgo,
    });
    store.add({
      hash: "fresh",
      filename: "fresh.jpg",
      savedPath: "/tmp/fresh.jpg",
      downloadedAt: new Date().toISOString(),
    });
    await store.flush();
    const hashes = store.snapshot().records.map((r) => r.hash);
    assert.ok(!hashes.includes("old"));
    assert.ok(hashes.includes("fresh"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("DownloadStore: needs_login outcomes count toward the failure streak", async () => {
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
      outcome: "needs_login",
      saved: 0,
      duplicates: 0,
      failures: 1,
      daysChecked: 0,
      error: "Login form without autofill",
    });
    assert.equal(store.snapshot().consecutiveFailures, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("DownloadStore: writes schemaVersion on save and tolerates legacy files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "myschoolone-store-"));
  try {
    // Simulate a legacy file without schemaVersion
    await fs.writeFile(
      path.join(dir, "downloads.json"),
      JSON.stringify({ records: [{ hash: "legacy", filename: "legacy.jpg", savedPath: "/tmp/legacy.jpg", downloadedAt: new Date().toISOString() }] }),
    );
    const store = new DownloadStore(dir);
    await store.load();
    assert.equal(store.hasHash("legacy"), true);
    await store.save();
    const saved = JSON.parse(await fs.readFile(path.join(dir, "downloads.json"), "utf8"));
    assert.equal(saved.schemaVersion, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
