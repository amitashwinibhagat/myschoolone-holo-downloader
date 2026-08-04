import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Config is a module-level singleton loaded from env, so configure it before
// importing the downloader modules. Compression is ON here.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "myschoolone-dl-compress-"));
process.env.HAI_API_KEY = "test-key";
process.env.SCHOOL_URL = "https://school.example.com";
process.env.DOWNLOAD_DIR = path.join(root, "downloads");
process.env.STATE_DIR = path.join(root, "state");
process.env.COMPRESS_IMAGES = "true";
process.env.JPEG_QUALITY = "80";
process.env.MAX_DIMENSION = "1024";

const sharp = (await import("sharp")).default;
const { DownloadManager } = await import("../src/downloads.js");
const { DownloadStore } = await import("../src/store.js");

test.after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test("saveFromBuffer: compresses PNG input to JPEG output", async () => {
  const store = new DownloadStore(process.env.STATE_DIR!);
  await store.load();
  const manager = new DownloadManager(store);

  const width = 256;
  const height = 256;
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = Math.floor(Math.random() * 256); // noise compresses poorly
  const png = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
  assert.ok(png.length > 8_000, "generated PNG must exceed the minimum size");

  const result = await manager.saveFromBuffer(png, "https://school.example.com/img.png", "image/png", "img.png", "2026-08-01");
  assert.equal(result.saved, true);

  const output = await fs.readFile(result.path!);
  assert.ok(output.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])), "output must be a JPEG");
  assert.ok(result.path!.endsWith(".jpg"), "output filename must use .jpg");
  assert.ok(output.length < png.length, "compressed output should be smaller than the PNG input");
});
