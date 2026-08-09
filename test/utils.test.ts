import assert from "node:assert/strict";
import test from "node:test";
import {
  sha256,
  dateInIndia,
  indiaTime,
  sanitizeFilename,
  redactPasswordValues,
  extensionForContentType,
  filenameFromUrl,
  filenameFromDisposition,
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
