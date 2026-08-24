import assert from "node:assert/strict";
import test from "node:test";

process.env.SCHOOL_URL = "https://school.example.com";
process.env.STATE_DIR = "/tmp/myschoolone-config-test-state";

const { config } = await import("../src/config.js");

test("config: loads the required school URL", () => {
  assert.equal(config.schoolUrl, "https://school.example.com");
});
