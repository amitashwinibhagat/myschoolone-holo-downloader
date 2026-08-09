import assert from "node:assert/strict";
import test from "node:test";

// Deliberately simulate an unconfigured AI key: read-only commands
// (npm run status / summary, Telegram /status) must work without it.
// dotenv never overrides an already-present env var, so setting it to "" is
// deterministic both locally (where a real .env exists) and in CI.
process.env.HAI_API_KEY = "";
process.env.SCHOOL_URL = "https://school.example.com";
process.env.STATE_DIR = "/tmp/myschoolone-config-test-state";

const { config } = await import("../src/config.js");

test("config: loads without an AI key (read-only commands)", () => {
  assert.equal(config.apiKey, "");
  assert.equal(config.schoolUrl, "https://school.example.com");
});
