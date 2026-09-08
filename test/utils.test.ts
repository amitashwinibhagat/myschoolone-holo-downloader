import assert from "node:assert/strict";
import test from "node:test";
import {
  sha256,
  dateInIndia,
  isoToPortalDate,
  daysAgoIso,
  indiaTime,
  sanitizeFilename,
  redactPasswordValues,
  extensionForContentType,
  filenameFromUrl,
  filenameFromDisposition,
  mapWithConcurrency,
  actionableHintFor,
} from "../src/utils.js";

test("sha256: produces consistent hex hash", () => {
  const hash = sha256(Buffer.from("hello world"));
  assert.equal(typeof hash, "string");
  assert.equal(hash.length, 64);
  assert.equal(hash, sha256(Buffer.from("hello world"))); // deterministic
  assert.notEqual(hash, sha256(Buffer.from("hello world!"))); // different input → different hash
});

test("dateInIndia: returns ISO date in IST", () => {
  // 2026-07-29T00:30:00Z = 2026-07-29T06:00:00+05:30 (IST)
  const date = new Date("2026-07-29T00:30:00Z");
  assert.equal(dateInIndia(date), "2026-07-29");
});

test("isoToPortalDate: converts YYYY-MM-DD to DD/MM/YYYY", () => {
  assert.equal(isoToPortalDate("2026-08-20"), "20/08/2026");
  assert.equal(isoToPortalDate("2025-01-05"), "05/01/2025");
});

test("daysAgoIso: returns valid IST ISO date", () => {
  const today = dateInIndia();
  assert.equal(daysAgoIso(0), today);
  assert.match(daysAgoIso(3), /^\d{4}-\d{2}-\d{2}$/);
});

test("indiaTime: returns correct calendar parts", () => {
  // 2026-07-29T09:30:00Z = 2026-07-29T15:00:00+05:30 (IST, Wednesday)
  const date = new Date("2026-07-29T09:30:00Z");
  const parts = indiaTime(date);
  assert.equal(parts.weekday, 3); // Wednesday
  assert.equal(parts.hour, 15);
  assert.equal(parts.minute, 0);
  assert.equal(parts.date, "2026-07-29");
});

test("sanitizeFilename: cleans unsafe characters", () => {
  assert.equal(sanitizeFilename("hello world"), "hello world");
  assert.equal(sanitizeFilename("file/with:bad*chars"), "file-with-bad-chars");
  assert.equal(sanitizeFilename("  spaces  "), "spaces");
  assert.equal(sanitizeFilename(""), "school-photo");
  assert.equal(sanitizeFilename("a".repeat(200)), "a".repeat(140));
});

test("extensionForContentType: maps MIME types", () => {
  assert.equal(extensionForContentType("image/jpeg"), ".jpg");
  assert.equal(extensionForContentType("image/png"), ".png");
  assert.equal(extensionForContentType("image/webp"), ".webp");
  assert.equal(extensionForContentType("image/gif"), ".gif");
  assert.equal(extensionForContentType("image/heic"), ".heic");
  assert.equal(extensionForContentType("image/avif"), ".avif");
  assert.equal(extensionForContentType("application/pdf"), "");
  assert.equal(extensionForContentType("image/jpeg; charset=utf-8"), ".jpg");
});

test("filenameFromUrl: extracts basename from URL", () => {
  assert.equal(filenameFromUrl("https://example.com/UploadFiles/photo.jpg"), "photo.jpg");
  assert.equal(filenameFromUrl("https://example.com/path/to/image.png"), "image.png");
  assert.equal(filenameFromUrl("https://example.com/"), "school-photo");
  assert.equal(filenameFromUrl("not-a-url"), "school-photo");
});

test("filenameFromDisposition: extracts filename from Content-Disposition", () => {
  assert.equal(filenameFromDisposition('attachment; filename="photo.jpg"'), "photo.jpg");
  assert.equal(filenameFromDisposition("attachment; filename=photo.jpg"), "photo.jpg");
  assert.equal(filenameFromDisposition("attachment; filename*=UTF-8''photo%201.jpg"), "photo 1.jpg");
  assert.equal(filenameFromDisposition(undefined), undefined);
  assert.equal(filenameFromDisposition(""), undefined);
});

test("redactPasswordValues: masks password input values", () => {
  assert.equal(
    redactPasswordValues('<input type="password" id="password" value="secret">'),
    '<input type="password" id="password" value="********">',
  );
  assert.equal(
    redactPasswordValues(`<input id="password" value='secret' type='password'>`),
    `<input id="password" value="********" type='password'>`,
  );
  assert.equal(
    redactPasswordValues('<input type="PASSWORD" value="Secret123">'),
    '<input type="PASSWORD" value="********">',
  );
});

test("redactPasswordValues: leaves non-password inputs and empty values untouched", () => {
  assert.equal(redactPasswordValues('<input type="text" value="hello">'), '<input type="text" value="hello">');
  assert.equal(redactPasswordValues('<input type="password">'), '<input type="password">');
  assert.equal(redactPasswordValues('<input type="password" value="">'), '<input type="password" value="********">');
});

test("redactPasswordValues: masks unquoted attributes", () => {
  assert.equal(redactPasswordValues("<input type=password value=secret>"), '<input type=password value="********">');
});

test("mapWithConcurrency: processes every item and preserves input order", async () => {
  const items = [1, 2, 3, 4, 5, 6, 7];
  const results = await mapWithConcurrency(items, 3, async (n) => n * 10);
  assert.deepEqual(results, [10, 20, 30, 40, 50, 60, 70]);
});

test("mapWithConcurrency: never exceeds the concurrency cap", async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  await mapWithConcurrency(items, 4, async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
  });
  assert.ok(peak <= 4, `peak in-flight ${peak} exceeded the cap of 4`);
  assert.ok(peak >= 2, `expected real parallelism, peak was only ${peak}`);
});

test("mapWithConcurrency: handles empty input and limit larger than item count", async () => {
  assert.deepEqual(await mapWithConcurrency([], 4, async (n: number) => n), []);
  assert.deepEqual(await mapWithConcurrency([1, 2], 8, async (n) => n + 1), [2, 3]);
});

test("mapWithConcurrency: a throwing task does not cancel its siblings when caught per-item", async () => {
  const seen: number[] = [];
  const results = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => {
    try {
      if (n === 2) throw new Error("boom");
      seen.push(n);
      return `ok-${n}`;
    } catch {
      return "failed";
    }
  });
  assert.deepEqual(results, ["ok-1", "failed", "ok-3", "ok-4"]);
  assert.deepEqual(seen.sort(), [1, 3, 4]);
});

test("actionableHintFor: login-flavored errors point at npm run login", () => {
  assert.ok(actionableHintFor(new Error("login fields not found"))?.includes("npm run login"));
  assert.ok(actionableHintFor(new Error("Session expired"))?.includes("npm run login"));
});

test("actionableHintFor: translates cryptic browser and network failures", () => {
  assert.ok(actionableHintFor(new Error("Target closed"))?.includes("rerun"));
  assert.ok(actionableHintFor(new Error("frame.goto: Protocol error (Page.navigate): No frame with given id found"))?.includes("rerun"));
  assert.ok(actionableHintFor(new Error("Timeout 30000ms exceeded"))?.includes("npm run health"));
  assert.ok(actionableHintFor(new Error("net::ERR_NAME_NOT_RESOLVED"))?.includes("internet"));
  assert.ok(actionableHintFor(new Error("Executable doesn't exist"))?.includes("install-browser"));
});

test("actionableHintFor: returns undefined for self-explanatory errors", () => {
  assert.equal(actionableHintFor(new Error("portal exploded")), undefined);
  assert.equal(actionableHintFor(undefined), undefined);
});
