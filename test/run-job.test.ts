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
