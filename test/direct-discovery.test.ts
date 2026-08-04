import assert from "node:assert/strict";
import test from "node:test";

// direct-api.ts imports config, so env must be present before the module loads.
process.env.HAI_API_KEY = "test-key";
process.env.SCHOOL_URL = "https://school.example.com";
process.env.STATE_DIR = "/nonexistent-dir-for-test";

const { replayBody, pickEndpoint, extractAttachmentUrls } = await import("../src/direct-api.js");
const { loadDiscoveryFile } = await import("../src/direct-discovery.js");

test("replayBody: substitutes date-shaped values with the target date", () => {
  const body = replayBody(
    [
      { name: "tdate", value: "04/08/2026" },
      { name: "type", value: "1" },
    ],
    "10/08/2026",
  );
  assert.ok(body.includes("tdate=10%2F08%2F2026"), body);
  assert.ok(body.includes("type=1"), body);
});

test("replayBody: falls back to a dailydate param when no date is present", () => {
  const body = replayBody([{ name: "type", value: "1" }], "10/08/2026");
  assert.ok(body.includes("dailydate=10%2F08%2F2026"), body);
});

test("replayBody: treats a date-named parameter with an empty value as the date field (legacy files)", () => {
  const body = replayBody(
    [
      { name: "tdate", value: "" },
      { name: "type", value: "" },
    ],
    "10/08/2026",
  );
  assert.ok(body.includes("tdate=10%2F08%2F2026"), body);
  assert.ok(!body.includes("dailydate"), body);
});

test("pickEndpoint: prefers POSTs with a date-shaped body parameter", () => {
  const file = {
    capturedAt: new Date().toISOString(),
    requests: [
      { method: "POST", path: "/api/other.php", queryParameters: [], bodyParameters: [{ name: "id", value: "42" }], resourceType: "xhr", status: 200, contentType: "text/html" },
      { method: "POST", path: "/Web/LearningManagement/daily_planner_parent_ajax.php", queryParameters: [], bodyParameters: [{ name: "tdate", value: "04/08/2026" }, { name: "type", value: "1" }], resourceType: "xhr", status: 200, contentType: "text/html" },
    ],
  };
  const picked = pickEndpoint(file as Parameters<typeof pickEndpoint>[0]);
  assert.equal(picked?.path, "/Web/LearningManagement/daily_planner_parent_ajax.php");
});

test("pickEndpoint: returns null for a file with no POSTs", () => {
  const file = {
    capturedAt: new Date().toISOString(),
    requests: [
      { method: "GET", path: "/x.php", queryParameters: [], bodyParameters: [], resourceType: "document", status: 200, contentType: "text/html" },
    ],
  };
  assert.equal(pickEndpoint(file as Parameters<typeof pickEndpoint>[0]), null);
});

test("extractAttachmentUrls: finds UploadFiles links and img srcs", () => {
  const html = `<a href="/UploadFiles/a.jpg">A</a><img src="/UploadFiles/b.png" />`;
  const urls = extractAttachmentUrls(html);
  assert.equal(urls.length, 2);
  assert.ok(urls.includes("/UploadFiles/a.jpg"));
  assert.ok(urls.includes("/UploadFiles/b.png"));
});

// The discovery loader must tolerate a missing file (returns null).
test("loadDiscoveryFile: returns null when the file does not exist", async () => {
  assert.equal(await loadDiscoveryFile(), null);
});
