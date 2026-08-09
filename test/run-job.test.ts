import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// run-job imports config, so env must be present before the module loads
// (CI has no .env file).
process.env.HAI_API_KEY = "test-key";
process.env.SCHOOL_URL = "https://school.example.com";
process.env.STATE_DIR = "";

const { acquireRunLock } = await import("../src/run-lock.js");
const { runJob } = await import("../src/run-job.js");
const { DownloadStore } = await import("../src/store.js");
const { NeedsHumanLoginError } = await import("../src/portal.js");

test("runJob: records skipped_locked when another run holds the lock", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "myschoolone-runjob-"));
  const lock = await acquireRunLock(stateDir, "reconcile", "scheduled");
  assert.equal(lock.acquired, true);

  try {
    const output = await runJob({
      source: "telegram",
      mode: "manual",
      lookbackDays: 7,
      stateDir,
    });

    assert.equal(output.skipped, true);
    assert.equal(output.ok, false);
    assert.equal(output.record.outcome, "skipped_locked");
    assert.equal(output.record.source, "telegram");
    assert.equal(output.record.mode, "manual");
    assert.ok(output.record.error?.includes("Locked by"));
    assert.equal(output.lockOwner?.source, "scheduled");
  } finally {
    await lock.release();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test("runJob: records a successful run with an injected downloader", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "myschoolone-runjob-"));
  try {
    const output = await runJob({
      source: "scheduled",
      mode: "reconcile",
      lookbackDays: 7,
      stateDir,
      runDownloadImpl: async () => ({
        saved: 3,
        duplicates: 1,
        failures: [],
        daysChecked: 7,
        transport: "direct",
      }),
    });

    assert.equal(output.ok, true);
    assert.equal(output.skipped, false);
    assert.equal(output.record.outcome, "success");
    assert.equal(output.record.saved, 3);
    assert.equal(output.record.duplicates, 1);
    assert.equal(output.record.transport, "direct");
    assert.equal(output.consecutiveFailures, 0);

    // The run record must be persisted to the store.
    const store = new DownloadStore(stateDir);
    await store.load();
    assert.equal(store.snapshot().runs?.length, 1);
    assert.equal(store.snapshot().lastSuccessfulRunAt, output.record.finishedAt);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test("runJob: records a failure when the downloader throws", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "myschoolone-runjob-"));
  try {
    const output = await runJob({
      source: "manual",
      mode: "manual",
      lookbackDays: 7,
      stateDir,
      runDownloadImpl: async () => {
        throw new Error("portal exploded");
      },
    });

    assert.equal(output.ok, false);
    assert.equal(output.skipped, false);
    assert.equal(output.record.outcome, "failure");
    assert.equal(output.record.failures, 1);
    assert.equal(output.record.error, "portal exploded");
    assert.equal(output.consecutiveFailures, 1);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test("runJob: records needs_login for NeedsHumanLoginError", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "myschoolone-runjob-"));
  try {
    const output = await runJob({
      source: "scheduled",
      mode: "fast",
      lookbackDays: 1,
      stateDir,
      runDownloadImpl: async () => {
        throw new NeedsHumanLoginError("Login form showing");
      },
    });

    assert.equal(output.ok, false);
    assert.equal(output.record.outcome, "needs_login");
    assert.equal(output.record.failures, 1);
    assert.equal(output.consecutiveFailures, 1);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
