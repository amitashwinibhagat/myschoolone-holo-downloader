import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Config is a module-level singleton loaded from env, so configure it before
// importing the downloader modules.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "myschoolone-dl-"));
process.env.SCHOOL_URL = "https://school.example.com";
process.env.DOWNLOAD_DIR = path.join(root, "downloads");
process.env.STATE_DIR = path.join(root, "state");
process.env.COMPRESS_IMAGES = "false";

const { DownloadManager, isTransientDownloadFailure } = await import("../src/downloads.js");
const { DownloadStore } = await import("../src/store.js");
const { sha256 } = await import("../src/utils.js");

test.after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

let storeCounter = 0;
/** Each test gets an isolated store so records never leak across tests. */
async function freshStore(): Promise<InstanceType<typeof DownloadStore>> {
  const dir = path.join(root, `state-${storeCounter++}`);
  const store = new DownloadStore(dir);
  await store.load();
  return store;
}

function imageBuffer(seed: string, size = 10_000): Buffer {
  const out = Buffer.alloc(size);
  for (let i = 0; i < out.length; i += 1) out[i] = seed.charCodeAt(i % seed.length);
  return out;
}

test("saveFromBuffer: writes the file and records a hash", async () => {
  const store = await freshStore();
  const manager = new DownloadManager(store);
  const body = imageBuffer("aaa");
  const result = await manager.saveFromBuffer(body, "https://school.example.com/photo.jpg", "image/jpeg", "photo.jpg", "2026-08-01");

  assert.equal(result.saved, true);
  assert.ok(result.path);
  assert.equal((await fs.readFile(result.path!)).length, body.length);
  assert.equal(store.hasHash(sha256(body)), true);
  await manager.flush();
});

test("saveFromBuffer: identical content is a duplicate", async () => {
  const store = await freshStore();
  const manager = new DownloadManager(store);
  const body = imageBuffer("bbb");
  const first = await manager.saveFromBuffer(body, "https://school.example.com/a.jpg", "image/jpeg", "a.jpg", "2026-08-01");
  const second = await manager.saveFromBuffer(body, "https://school.example.com/a.jpg", "image/jpeg", "a.jpg", "2026-08-01");

  assert.equal(first.saved, true);
  assert.equal(second.saved, false);
  assert.equal(second.duplicate, true);
  assert.equal(store.snapshot().records.length, 1);
});

test("saveFromBuffer: rejects tiny (<8KB) payloads", async () => {
  const store = await freshStore();
  const manager = new DownloadManager(store);
  const result = await manager.saveFromBuffer(imageBuffer("c", 1000), "https://school.example.com/tiny.jpg", "image/jpeg", "tiny.jpg", "2026-08-01");
  assert.equal(result.saved, false);
  assert.equal(result.reason, "Image was smaller than 8 KB");
});

test("saveFromBuffer: sanitizes filenames and adds the right extension", async () => {
  const store = await freshStore();
  const manager = new DownloadManager(store);
  const body = imageBuffer("ddd");
  const result = await manager.saveFromBuffer(body, "https://school.example.com/x", "image/png", 'weird "name" ?:.png', "2026-08-01");
  assert.equal(result.saved, true);
  const base = path.basename(result.path!);
  assert.ok(base.endsWith(".png"), base);
  assert.ok(base.length >= 11, base); // hash prefix + dash + name
});

test("saveFromBuffer: stats counter tracks saved/duplicates", async () => {
  const store = await freshStore();
  const manager = new DownloadManager(store);
  const body = imageBuffer("eee");
  await manager.saveFromBuffer(body, "https://school.example.com/s.jpg", "image/jpeg", "s.jpg", "2026-08-01");
  await manager.saveFromBuffer(body, "https://school.example.com/s.jpg", "image/jpeg", "s.jpg", "2026-08-01");
  await manager.saveFromBuffer(imageBuffer("fff"), "https://school.example.com/t.jpg", "image/jpeg", "t.jpg", "2026-08-01");
  assert.deepEqual(manager.stats(), { saved: 2, duplicates: 1 });
});

test("isTransientDownloadFailure: retries rate limits, 5xx, and no-response failures", () => {
  assert.equal(isTransientDownloadFailure(429), true);
  assert.equal(isTransientDownloadFailure(500), true);
  assert.equal(isTransientDownloadFailure(503), true);
  assert.equal(isTransientDownloadFailure(undefined), true);
});

test("isTransientDownloadFailure: permanent failures are not retried", () => {
  assert.equal(isTransientDownloadFailure(200), false);
  assert.equal(isTransientDownloadFailure(400), false);
  assert.equal(isTransientDownloadFailure(403), false);
  assert.equal(isTransientDownloadFailure(404), false);
});

type FetchStep = { status: number; ok: boolean; error?: string };

/** Stub of the Playwright Page surface that saveFromUrl touches. */
function stubImagePage(script: FetchStep[], seen: { calls: number }, seed: string) {
  return {
    url: () => "https://school.example.com/Web/LearningManagement/daily_planner_parent.php",
    context: () => ({
      request: {
        get: async () => {
          const step = script[Math.min(seen.calls, script.length - 1)];
          seen.calls += 1;
          if (step.error) throw new Error(step.error);
          return {
            ok: () => step.ok,
            status: () => step.status,
            headers: () => ({
              "content-type": step.ok ? "image/jpeg" : "text/html",
              "content-disposition": "",
            }),
            body: async () => imageBuffer(`${seed}-${seen.calls}`),
          };
        },
      },
    }),
  };
}

test("saveFromUrl: retries a transient 503 then saves", async () => {
  const store = await freshStore();
  const manager = new DownloadManager(store);
  const seen = { calls: 0 };
  const result = await manager.saveFromUrl(
    stubImagePage(
      [
        { status: 503, ok: false },
        { status: 200, ok: true },
      ],
      seen,
      "retry503",
    ) as never,
    "https://school.example.com/UploadFiles/school/photo.jpg",
    "",
    "2026-08-02",
  );
  assert.equal(result.saved, true);
  assert.equal(seen.calls, 2);
});

test("saveFromUrl: retries a thrown network error then saves", async () => {
  const store = await freshStore();
  const manager = new DownloadManager(store);
  const seen = { calls: 0 };
  const result = await manager.saveFromUrl(
    stubImagePage(
      [
        { status: 0, ok: false, error: "ECONNRESET" },
        { status: 200, ok: true },
      ],
      seen,
      "retrynet",
    ) as never,
    "https://school.example.com/UploadFiles/school/photo.jpg",
    "",
    "2026-08-02",
  );
  assert.equal(result.saved, true);
  assert.equal(seen.calls, 2);
});

test("saveFromUrl: does not retry a permanent 404", async () => {
  const store = await freshStore();
  const manager = new DownloadManager(store);
  const seen = { calls: 0 };
  const result = await manager.saveFromUrl(
    stubImagePage([{ status: 404, ok: false }], seen, "retry404") as never,
    "https://school.example.com/UploadFiles/school/missing.jpg",
    "",
    "2026-08-02",
  );
  assert.equal(result.saved, false);
  assert.match(result.reason || "", /HTTP 404/);
  assert.equal(seen.calls, 1);
});
