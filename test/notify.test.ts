import assert from "node:assert/strict";
import test from "node:test";

// notify.ts imports config, so env must be present before the module loads.
process.env.SCHOOL_URL = "https://school.example.com";
process.env.STATE_DIR = "/nonexistent-dir-for-test";
// With Telegram configured, notify() uses fetch — which this file mocks — so
// tests never pop up macOS notifications or hit the real Telegram API.
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "12345";

const calls: Array<{ url: string; body: { text?: string } }> = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
  return new Response('{"ok":true}', { status: 200 });
}) as typeof fetch;

const { notify, notifyRunFailure } = await import("../src/notify.js");

test("notifyRunFailure: needs_login sends a LOGIN REQUIRED message", async () => {
  await notifyRunFailure("session expired boom", "needs_login", 5);
  const last = calls[calls.length - 1];
  assert.ok(last.url.includes("test-token"));
  assert.ok(last.body.text?.includes("LOGIN REQUIRED"));
  assert.ok(last.body.text?.includes("npm run login"));
});

test("notifyRunFailure: generic failure sends FAILED and escalates only at a 3+ streak", async () => {
  await notifyRunFailure("boom", "failure", 2);
  await notifyRunFailure("boom", "failure", 3);
  const texts = calls.map((c) => c.body.text || "");
  assert.equal(texts.filter((t) => t.includes("FAILED")).length, 2);
  assert.equal(texts.filter((t) => t.includes("ACTION NEEDED")).length, 1);
});

test("notify: a Telegram error response never rejects the run", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{"ok":false}', { status: 429 })) as typeof fetch;
  try {
    await notify("title", "message");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("notify: a Telegram network failure never rejects the run", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  try {
    await notify("title", "message");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("notifyRunFailure: prepends the hint so it survives the length cap", async () => {
  const before = calls.length;
  await notifyRunFailure(`x`.repeat(300), "failure", 1, "Next step: just rerun.");
  const last = calls[calls.length - 1];
  const text = last.body.text || "";
  // The hint comes before the (truncated) raw error, right after the title.
  assert.ok(text.includes("Next step: just rerun."));
  assert.ok(text.indexOf("Next step: just rerun.") < text.indexOf("xxxx"));
  assert.equal(calls.length, before + 1);
});
