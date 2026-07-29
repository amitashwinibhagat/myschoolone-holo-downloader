import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireRunLock } from "../src/run-lock.js";

test("prevents concurrent owners and releases cleanly", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "myschoolone-lock-"));
  try {
    const first = await acquireRunLock(stateDir, "fast", "scheduled");
    assert.equal(first.acquired, true);

    const second = await acquireRunLock(stateDir, "manual", "manual");
    assert.equal(second.acquired, false);
    assert.equal(second.owner?.pid, process.pid);

    await first.release();
    const third = await acquireRunLock(stateDir, "manual", "manual");
    assert.equal(third.acquired, true);
    await third.release();
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
