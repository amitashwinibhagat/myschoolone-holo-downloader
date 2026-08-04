import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Config is a module-level singleton loaded from env, so configure it before
// importing the downloader modules.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "myschoolone-dl-"));
process.env.HAI_API_KEY = "test-key";
process.env.SCHOOL_URL = "https://school.example.com";
process.env.DOWNLOAD_DIR = path.join(root, "downloads");
process.env.STATE_DIR = path.join(root, "state");
process.env.COMPRESS_IMAGES = "false";

const { DownloadManager } = await import("../src/downloads.js");
const { DownloadStore } = await import("../src/store.js");
const { sha256 } = await import("../src/utils.js");

test.after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

let storeCounter = 0;
/** Each test gets an isolated store so records never leak across tests. */
async function freshStore(): Promise<DownloadStore> {
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
