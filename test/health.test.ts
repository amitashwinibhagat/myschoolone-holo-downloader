import assert from "node:assert/strict";
import test from "node:test";

// health.ts imports config, so env must be present before the module loads.
process.env.HAI_API_KEY = "test-key";
process.env.SCHOOL_URL = "https://school.example.com";
process.env.STATE_DIR = "";

const { decideBaseline, diffFingerprints } = await import("../src/health.js");

// These are pure functions and do not touch config or the network.

function fingerprint(hash: string, selectors: Record<string, string> = {}): Parameters<typeof decideBaseline>[1] {
  return { capturedAt: "2026-08-01T00:00:00Z", url: "https://x", selectors, scripts: [], endpoints: [], hash };
}

test("diffFingerprints: empty when identical", () => {
  const fp = fingerprint("same", { dailydate: "INPUT" });
  assert.deepEqual(diffFingerprints(fp, fp), []);
});

test("diffFingerprints: detects added, removed and changed selectors + endpoints", () => {
  const baseline = fingerprint("a", { dailydate: "INPUT", sidebar: "NAV" });
  const current = fingerprint("b", { dailydate: "SELECT", contentArea: "MAIN" });
  const changes = diffFingerprints(baseline, current);
  assert.ok(changes.some((c) => c.includes("Selector changed: dailydate")));
  assert.ok(changes.some((c) => c.includes("Selector removed: sidebar")));
  assert.ok(changes.some((c) => c.includes("New selector: contentArea")));
});

test("decideBaseline: first capture creates a baseline", () => {
  assert.deepEqual(decideBaseline(null, fingerprint("h"), []), { action: "first_capture" });
});

test("decideBaseline: identical fingerprint is unchanged", () => {
  const baseline = fingerprint("h");
  assert.deepEqual(decideBaseline(baseline, fingerprint("h"), []), { action: "unchanged" });
});

test("decideBaseline: first sighting of a change stays pending (baseline kept)", () => {
  const baseline = fingerprint("old");
  const decision = decideBaseline(baseline, fingerprint("new", { dailydate: "SELECT" }), ["Selector changed"]);
  assert.equal(decision.action, "pending_change");
  assert.ok(decision.changes?.includes("Selector changed"));
});

test("decideBaseline: a second identical change is accepted as the new baseline", () => {
  const baseline = fingerprint("old", { dailydate: "INPUT" });
  const changed = fingerprint("new", { dailydate: "SELECT" });
  const changes = diffFingerprints(baseline, changed);
  const first = decideBaseline(baseline, changed, changes);
  assert.equal(first.action, "pending_change");

  // Simulate the persisted baseline now carrying the pending change.
  const pendingBaseline = { ...baseline, pendingChange: { hash: changed.hash, detectedAt: "x", changes } };
  const second = decideBaseline(pendingBaseline, changed, diffFingerprints(pendingBaseline, changed));
  assert.equal(second.action, "accepted_change");
});

test("decideBaseline: a different second change stays pending (not accepted)", () => {
  const baseline = fingerprint("old", { dailydate: "INPUT" });
  const changeA = fingerprint("changeA", { dailydate: "SELECT" });
  const pendingBaseline = {
    ...baseline,
    pendingChange: { hash: changeA.hash, detectedAt: "x", changes: ["a"] },
  };
  const changeB = fingerprint("changeB", { dailydate: "TEXTAREA" });
  const decision = decideBaseline(pendingBaseline, changeB, ["b"]);
  assert.equal(decision.action, "pending_change");
});

test("decideBaseline: portal returning to normal clears the pending change", () => {
  const baseline = fingerprint("old", { dailydate: "INPUT" });
  const pendingBaseline = { ...baseline, pendingChange: { hash: "something", detectedAt: "x", changes: ["a"] } };
  const decision = decideBaseline(pendingBaseline, fingerprint("old", { dailydate: "INPUT" }), []);
  assert.equal(decision.action, "recovered");
});
