import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// E2E: the real runDownload/runJob pipeline against a mocked portal.
// Exercises the full direct-poll path — session check → daily-log POST →
// attachment discovery → direct download → SHA-256 dedup → disk persistence —
// with globalThis.fetch serving a fake MySchoolOne portal. No live network,
// no browser, no .env access.

const root = await fs.mkdtemp(path.join(os.tmpdir(), "myschoolone-e2e-"));
const STATE_DIR = path.join(root, "state");
const DOWNLOAD_DIR = path.join(root, "downloads");
process.env.HAI_API_KEY = "test-key";
process.env.SCHOOL_URL = "https://school.example.com";
process.env.STATE_DIR = STATE_DIR;
process.env.DOWNLOAD_DIR = DOWNLOAD_DIR;
process.env.DIRECT_POLL = "true";
process.env.COMPRESS_IMAGES = "false";
process.env.AI_MODE = "none";

const { runDownload } = await import("../src/run-download.js");
const { runJob } = await import("../src/run-job.js");
const { DownloadStore } = await import("../src/store.js");

// What `npm run login` would have produced: a saved Playwright storage state.
await fs.mkdir(STATE_DIR, { recursive: true });
await fs.writeFile(
  path.join(STATE_DIR, "browser-storage-state.json"),
  JSON.stringify({
    cookies: [
      { name: "PHPSESSID", value: "e2e-session", domain: "school.example.com", path: "/", expires: -1 },
    ],
  }),
);

const IMAGE_BYTES = Buffer.alloc(12_000, 0xab); // > 8 KB so saveBuffer accepts it

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  const parsed = new URL(url);

  if (parsed.pathname.includes("/UploadFiles/")) {
    // Attachment image — unique bytes per URL so each file hashes differently.
    return new Response(new Uint8Array(Buffer.concat([IMAGE_BYTES, Buffer.from(parsed.pathname)])), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });
  }

  if (parsed.pathname.endsWith("/daily_planner_parent.php")) {
    if (method === "POST") {
      // Daily-log reply: two same-origin attachments and one off-origin link
      // that must be refused.
      return new Response(
        `<html><body>
          <a href="/UploadFiles/school/photo1.jpg">Photo 1</a>
          <a href="/UploadFiles/school/photo2.png">Photo 2</a>
          <a href="https://evilschool.example.com/UploadFiles/evil.jpg">Evil</a>
        </body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }
    // Session check GET.
    return new Response("<html><body>Daily log</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  }

  return new Response("not found", { status: 404 });
}) as typeof fetch;

test.after(async () => {
  globalThis.fetch = realFetch;
  await fs.rm(root, { recursive: true, force: true });
});

test("E2E: direct-poll run downloads, persists, dedupes, and rejects off-origin links", async () => {
  const store = new DownloadStore(STATE_DIR);
  await store.load();

  const first = await runDownload(store, 1);
  assert.equal(first.transport, "direct");
  assert.equal(first.saved, 2);
  assert.equal(first.duplicates, 0);
  assert.equal(first.daysChecked, 1);
  // The off-origin link must be refused without a request.
  assert.equal(first.failures.length, 1);
  assert.match(first.failures[0], /evil\.jpg/);

  // runDownload batches persistence; the caller (runJob) flushes. Do the same.
  await store.flush();

  // Files landed on disk under the date folder.
  const files = await fs.readdir(DOWNLOAD_DIR, { recursive: true });
  const images = files.filter((f) => /\.(jpg|png)$/.test(f));
  assert.equal(images.length, 2);
  const content = await fs.readFile(path.join(DOWNLOAD_DIR, images[0]));
  assert.ok(content.length >= 12_000, "downloaded file should carry the image bytes");

  // Store persisted the records.
  const reloaded = new DownloadStore(STATE_DIR);
  await reloaded.load();
  assert.equal(reloaded.snapshot().records.length, 2);

  // Re-running the same content must not create repeated files.
  const second = await runDownload(reloaded, 1);
  assert.equal(second.transport, "direct");
  assert.equal(second.saved, 0);
  assert.equal(second.duplicates, 2);
});

test("E2E: runJob orchestrates the direct run and records it", async () => {
  const stateDir = path.join(root, "state-runjob");
  const output = await runJob({
    source: "scheduled",
    mode: "reconcile",
    lookbackDays: 1,
    stateDir,
  });

  assert.equal(output.ok, true);
  assert.equal(output.skipped, false);
  assert.equal(output.record.outcome, "success");
  assert.equal(output.record.transport, "direct");
  assert.equal(output.record.saved, 2);
  assert.equal(output.record.failures, 1); // the off-origin link
  assert.equal(output.record.daysChecked, 1);
  assert.equal(output.consecutiveFailures, 0);

  const store = new DownloadStore(stateDir);
  await store.load();
  assert.equal(store.snapshot().runs?.length, 1);
});
