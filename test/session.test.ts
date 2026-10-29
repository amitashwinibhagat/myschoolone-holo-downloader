import assert from "node:assert/strict";
import test from "node:test";

// session.ts imports config, so env must be present before the module loads.
process.env.SCHOOL_URL = "https://school.example.com";

const { classifySessionBody } = await import("../src/session.js");

test("classifySessionBody: plain page is ok", () => {
  assert.equal(classifySessionBody("<html><body>Daily Log</body></html>", "https://school.example.com/Web/LearningManagement/daily_planner_parent.php"), "ok");
});

test("classifySessionBody: password input means expired", () => {
  const html = `<html><body><input type="password" name="pw"><input type="text" name="user"></body></html>`;
  assert.equal(classifySessionBody(html, "https://school.example.com/Web/LearningManagement/daily_planner_parent.php"), "expired");
});

test("classifySessionBody: login redirect URL means expired", () => {
  assert.equal(classifySessionBody("<html><body>Redirecting</body></html>", "https://school.example.com/login?next=/"), "expired");
});

test("classifySessionBody: Cloudflare interstitial means challenge", () => {
  assert.equal(classifySessionBody("Checking your browser before accessing...", "https://school.example.com/"), "challenge");
  assert.equal(classifySessionBody("Just a moment...", "https://school.example.com/"), "challenge");
  assert.equal(classifySessionBody("Verifying you are human", "https://school.example.com/"), "challenge");
});

// Regression: the session check used to carry only four challenge markers while
// the browser detector carried seven. A managed challenge that words itself
// with the body-only markers was classified "ok" here, so the direct-poll path
// was sent straight into an interstitial. Both now share one list.
test("classifySessionBody: managed-challenge body text means challenge", () => {
  for (const marker of [
    "Performing security verification",
    "This site verifies you are not a bot",
    "Enable JavaScript and cookies to continue",
  ]) {
    assert.equal(classifySessionBody(`<html><body>${marker}</body></html>`, "https://school.example.com/"), "challenge", marker);
  }
});

test("classifySessionBody: marker matching is case-insensitive", () => {
  assert.equal(classifySessionBody("PERFORMING SECURITY VERIFICATION", "https://school.example.com/"), "challenge");
});

test("classifySessionBody: ordinary portal copy is not a challenge", () => {
  assert.equal(classifySessionBody("<html><body>Your child's daily log</body></html>", "https://school.example.com/x"), "ok");
});
