import assert from "node:assert";
import { describe, it } from "node:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { DownloadStore } from "../src/store.js";
import { formatStatus, helpText } from "../src/telegram-format.js";

async function tempStateDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-format-test-"));
  return dir;
}

describe("formatStatus", () => {
  it("shows defaults for an empty store", async () => {
    const stateDir = await tempStateDir();
    const store = new DownloadStore(stateDir);
    await store.load();

    const text = formatStatus(store);

    assert.ok(text.includes("School Photos Status"));
    assert.ok(text.includes("Total: 0"));
    assert.ok(text.includes("This week: 0"));
    assert.ok(text.includes("This month: 0"));
    assert.ok(text.includes("Last run: never"));
    assert.ok(text.includes("Failure rate: 0%"));
    assert.ok(text.includes("Transport: unknown"));

    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("reflects saved records and a recent successful run", async () => {
    const stateDir = await tempStateDir();
    const store = new DownloadStore(stateDir);
    await store.load();

    store.add({
      hash: "abc",
      filename: "test.jpg",
      savedPath: "/tmp/2026-01-01/test.jpg",
      downloadedAt: new Date().toISOString(),
    });
    await store.recordRun({
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      source: "scheduled",
      mode: "reconcile",
      transport: "direct",
      outcome: "success",
      saved: 1,
      duplicates: 0,
      failures: 0,
      daysChecked: 7,
    });

    const text = formatStatus(store);

    assert.ok(text.includes("Total: 1"));
    assert.ok(text.includes("This week: 1"));
    assert.ok(text.includes("This month: 1"));
    assert.ok(text.includes("Transport: direct"));

    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("counts failures in the failure rate", async () => {
    const stateDir = await tempStateDir();
    const store = new DownloadStore(stateDir);
    await store.load();

    for (let i = 0; i < 4; i += 1) {
      await store.recordRun({
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        source: "scheduled",
        mode: "fast",
        transport: "browser",
        outcome: i < 2 ? "failure" : "success",
        saved: 0,
        duplicates: 0,
        failures: 1,
        daysChecked: 0,
        error: "boom",
      });
    }

    const text = formatStatus(store);

    assert.ok(text.includes("Failure rate: 50%"));
    assert.ok(text.includes("0 streak"));

    await fs.rm(stateDir, { recursive: true, force: true });
  });
});

describe("helpText", () => {
  it("lists the supported commands", () => {
    assert.ok(helpText.includes("/run"));
    assert.ok(helpText.includes("/status"));
    assert.ok(helpText.includes("/help"));
  });
});
