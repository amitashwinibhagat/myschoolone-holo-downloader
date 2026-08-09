import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// node --test isolates each file in its own process, so this file gets a fresh
// config singleton with an overridden attachment-host allowlist.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "myschoolone-direct-api-override-"));
process.env.HAI_API_KEY = "test-key";
process.env.SCHOOL_URL = "https://school.example.com";
process.env.STATE_DIR = path.join(root, "state");
process.env.ATTACHMENT_ALLOWED_HOSTS = "custom-cdn.example.com,.static.example.org";

const { attachmentHostAllowed } = await import("../src/direct-api.js");

test.after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test("ATTACHMENT_ALLOWED_HOSTS: configured hosts are allowed", () => {
  assert.equal(attachmentHostAllowed(new URL("https://custom-cdn.example.com/x.jpg")), true);
  // Leading dot entry: subdomains are covered too.
  assert.equal(attachmentHostAllowed(new URL("https://img.static.example.org/x.jpg")), true);
});

test("ATTACHMENT_ALLOWED_HOSTS: merges with the built-in default CDN", () => {
  assert.equal(attachmentHostAllowed(new URL("https://d12sqqae3msmf.cloudfront.net/x.jpg")), true);
});

test("ATTACHMENT_ALLOWED_HOSTS: school host and subdomains stay allowed", () => {
  assert.equal(attachmentHostAllowed(new URL("https://school.example.com/x.jpg")), true);
  assert.equal(attachmentHostAllowed(new URL("https://uploads.school.example.com/x.jpg")), true);
});
