import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Cookie } from "../src/direct-api.js";

// Config is a module-level singleton loaded from env, so configure it before
// importing the module under test (same pattern as downloads.test.ts).
const root = await fs.mkdtemp(path.join(os.tmpdir(), "myschoolone-direct-api-"));
process.env.HAI_API_KEY = "test-key";
process.env.SCHOOL_URL = "https://school.example.com";
process.env.STATE_DIR = path.join(root, "state");

const { attachmentHostAllowed, buildCookieHeader, extractAttachmentUrls, fetchAttachmentBuffer, fetchSameOrigin, nextRedirectRequest, pickEndpoint, replayBody } =
  await import("../src/direct-api.js");

test.after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function cookie(overrides: Partial<Cookie> = {}): Cookie {
  return { name: "sid", value: "abc123", domain: "school.example.com", path: "/", ...overrides };
}

// --- extractAttachmentUrls (the real implementation, not a copy) ---

test("extractAttachmentUrls: finds UploadFiles links in HTML", () => {
  const html = `
    <a href="/UploadFiles/school/photo1.jpg">Photo 1</a>
    <img src="/UploadFiles/school/photo2.png" />
    <a href="/other/path/file.pdf">PDF</a>
    <a href="/UploadFiles/gallery/img_001.webp">Gallery</a>
  `;
  assert.deepEqual(extractAttachmentUrls(html).sort(), [
    "/UploadFiles/gallery/img_001.webp",
    "/UploadFiles/school/photo1.jpg",
    "/UploadFiles/school/photo2.png",
  ]);
});

test("extractAttachmentUrls: returns empty for no matches", () => {
  assert.deepEqual(extractAttachmentUrls("<a href='/other/file.pdf'>PDF</a>"), []);
  assert.deepEqual(extractAttachmentUrls(""), []);
});

test("extractAttachmentUrls: deduplicates identical URLs", () => {
  const html = `
    <a href="/UploadFiles/photo.jpg">Link</a>
    <img src="/UploadFiles/photo.jpg" />
    <a href="/UploadFiles/photo.jpg">Another link</a>
  `;
  assert.deepEqual(extractAttachmentUrls(html), ["/UploadFiles/photo.jpg"]);
});

test("extractAttachmentUrls: handles single-quoted attributes", () => {
  assert.deepEqual(extractAttachmentUrls(`<a href='/UploadFiles/photo.jpg'>Photo</a>`), [
    "/UploadFiles/photo.jpg",
  ]);
});

// --- buildCookieHeader (host-boundary matching) ---

test("buildCookieHeader: sends the cookie to its exact host", () => {
  const url = new URL("https://school.example.com/Web/x.php");
  assert.equal(buildCookieHeader([cookie()], url), "sid=abc123");
});

test("buildCookieHeader: matches subdomains for a leading-dot domain", () => {
  const url = new URL("https://uploads.school.example.com/photo.jpg");
  assert.equal(buildCookieHeader([cookie({ domain: ".school.example.com" })], url), "sid=abc123");
});

test("buildCookieHeader: host-only cookie is NOT sent to subdomains", () => {
  // Playwright serializes host-only cookies without a leading dot; browsers
  // send those to the exact host only.
  const url = new URL("https://uploads.school.example.com/photo.jpg");
  assert.equal(buildCookieHeader([cookie({ domain: "school.example.com" })], url), "");
});

test("buildCookieHeader: never matches a look-alike suffix host (regression)", () => {
  // `evilschool.example.com` must NOT receive a cookie scoped to
  // `school.example.com` — a plain `endsWith` check would wrongly match.
  const url = new URL("https://evilschool.example.com/photo.jpg");
  assert.equal(buildCookieHeader([cookie()], url), "");
});

test("buildCookieHeader: never matches a host ending in the domain inside a longer label", () => {
  const url = new URL("https://school.example.com.evil.net/photo.jpg");
  assert.equal(buildCookieHeader([cookie()], url), "");
});

test("buildCookieHeader: rejects unrelated hosts", () => {
  const url = new URL("https://other.example.org/x");
  assert.equal(buildCookieHeader([cookie()], url), "");
});

test("buildCookieHeader: compares host and domain case-insensitively", () => {
  const url = new URL("https://SCHOOL.EXAMPLE.COM/x");
  assert.equal(buildCookieHeader([cookie({ domain: "School.Example.COM" })], url), "sid=abc123");
});

test("buildCookieHeader: honors the cookie path prefix", () => {
  const url = new URL("https://school.example.com/Web/daily.php");
  assert.equal(buildCookieHeader([cookie({ path: "/Web" })], url), "sid=abc123");
  assert.equal(buildCookieHeader([cookie({ path: "/Other" })], url), "");
});

// --- replayBody (date substitution) ---

test("replayBody: substitutes the portal date for a date-shaped value", () => {
  const body = new URLSearchParams(
    replayBody(
      [
        { name: "tdate", value: "01/01/2000" },
        { name: "type", value: "3" },
      ],
      "05/04/2026",
    ),
  );
  assert.equal(body.get("tdate"), "05/04/2026");
  assert.equal(body.get("type"), "3");
});

test("replayBody: substitutes a date-named parameter even without a date value", () => {
  const body = new URLSearchParams(replayBody([{ name: "dailydate", value: "" }], "05/04/2026"));
  assert.equal(body.get("dailydate"), "05/04/2026");
});

test("replayBody: falls back to dailydate when no date parameter exists", () => {
  const body = new URLSearchParams(replayBody([{ name: "type", value: "daily" }], "05/04/2026"));
  assert.equal(body.get("dailydate"), "05/04/2026");
  assert.equal(body.get("type"), "daily");
});

// --- fetchAttachmentBuffer (off-origin rejection, no network involved) ---

test("fetchAttachmentBuffer: refuses off-origin absolute URLs without making a request", async () => {
  const cookies = [cookie()];
  assert.equal(await fetchAttachmentBuffer(cookies, "https://evilschool.example.com/photo.jpg"), null);
  assert.equal(await fetchAttachmentBuffer(cookies, "https://school.example.com.evil.net/photo.jpg"), null);
  assert.equal(await fetchAttachmentBuffer(cookies, "//uploads.evil.net/photo.jpg"), null);
});

// --- pickEndpoint (discovery selection) ---

test("pickEndpoint: prefers a POST request carrying a date value and rejects protocol-relative paths", () => {
  const file = {
    capturedAt: new Date().toISOString(),
    requests: [
      {
        method: "GET",
        path: "/Web/a.php",
        queryParameters: [],
        bodyParameters: [],
        resourceType: "document",
        status: 200,
        contentType: "text/html",
      },
      {
        method: "POST",
        path: "/Web/b.php",
        queryParameters: [],
        bodyParameters: [{ name: "dailydate", value: "01/01/2000" }],
        resourceType: "xhr",
        status: 200,
        contentType: "text/html",
      },
      {
        method: "POST",
        path: "//evil.example.com/p.php",
        queryParameters: [],
        bodyParameters: [],
        resourceType: "xhr",
        status: 200,
        contentType: "text/html",
      },
    ],
  };
  assert.equal(pickEndpoint(file)?.path, "/Web/b.php");
});

// --- attachmentHostAllowed (download gate) ---

test("attachmentHostAllowed: allows the school host and its subdomains", () => {
  assert.equal(attachmentHostAllowed(new URL("https://school.example.com/x.jpg")), true);
  assert.equal(attachmentHostAllowed(new URL("https://uploads.school.example.com/x.jpg")), true);
  assert.equal(attachmentHostAllowed(new URL("https://a.b.school.example.com/x.jpg")), true);
});

test("attachmentHostAllowed: rejects look-alike hosts and protocol mismatches", () => {
  assert.equal(attachmentHostAllowed(new URL("https://evilschool.example.com/x.jpg")), false);
  assert.equal(attachmentHostAllowed(new URL("https://school.example.com.evil.net/x.jpg")), false);
  assert.equal(attachmentHostAllowed(new URL("http://school.example.com/x.jpg")), false);
  assert.equal(attachmentHostAllowed(new URL("https://other.example.org/x.jpg")), false);
});

test("attachmentHostAllowed: allows the built-in MySchoolOne CloudFront CDN", () => {
  assert.equal(
    attachmentHostAllowed(new URL("https://d12sqqae3msmf.cloudfront.net/myschoolone.com/1002/UploadFiles/x.jpeg")),
    true,
  );
});

test("attachmentHostAllowed: rejects any other CloudFront distribution", () => {
  assert.equal(attachmentHostAllowed(new URL("https://attacker123.cloudfront.net/x.jpeg")), false);
});

// --- nextRedirectRequest (pure redirect decision) ---

const sameOrigin = (url: URL) => url.origin === "https://school.example.com";

test("nextRedirectRequest: follows a same-origin 302 as a GET without a body", () => {
  const next = nextRedirectRequest(302, "/login", "https://school.example.com/a.php", sameOrigin, 0, 5, "POST", "x=1");
  assert.deepEqual(next, { url: "https://school.example.com/login", method: "GET", body: undefined });
});

test("nextRedirectRequest: keeps method and body for 307/308", () => {
  const next = nextRedirectRequest(307, "/b.php", "https://school.example.com/a.php", sameOrigin, 0, 5, "POST", "x=1");
  assert.deepEqual(next, { url: "https://school.example.com/b.php", method: "POST", body: "x=1" });
});

test("nextRedirectRequest: refuses an off-origin redirect", () => {
  assert.equal(nextRedirectRequest(302, "https://evil.example.net/x", "https://school.example.com/a.php", sameOrigin, 0, 5, "GET", undefined), null);
  assert.equal(nextRedirectRequest(302, "https://school.example.com.evil.net/x", "https://school.example.com/a.php", sameOrigin, 0, 5, "GET", undefined), null);
});

test("nextRedirectRequest: refuses once the redirect limit is reached", () => {
  assert.equal(nextRedirectRequest(302, "/x", "https://school.example.com/a.php", sameOrigin, 5, 5, "GET", undefined), null);
});

test("nextRedirectRequest: ignores non-3xx responses and missing locations", () => {
  assert.equal(nextRedirectRequest(200, "/x", "https://school.example.com/a.php", sameOrigin, 0, 5, "GET", undefined), null);
  assert.equal(nextRedirectRequest(302, null, "https://school.example.com/a.php", sameOrigin, 0, 5, "GET", undefined), null);
  assert.equal(nextRedirectRequest(404, "/x", "https://school.example.com/a.php", sameOrigin, 0, 5, "GET", undefined), null);
});

// --- fetchSameOrigin (per-hop cookie scoping, with a mocked fetch) ---

test("fetchSameOrigin: recomputes the Cookie header per hop so no cookie crosses hosts", async () => {
  const seen: Array<{ url: string; cookie: string | null }> = [];
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      seen.push({ url, cookie: new Headers(init?.headers).get("cookie") });
      if (url.startsWith("https://school.example.com")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://d12sqqae3msmf.cloudfront.net/myschoolone.com/1002/x.jpeg" },
        });
      }
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const cookies = [
      cookie(), // host-only school cookie
      cookie({ name: "cf", value: "edge", domain: ".cloudfront.net" }),
    ];
    const response = await fetchSameOrigin(
      "https://school.example.com/photo.jpg",
      { method: "GET" },
      attachmentHostAllowed,
      { cookies },
    );
    assert.equal(response.status, 200);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].cookie, "sid=abc123"); // school cookie on the school host only
    assert.equal(seen[1].url, "https://d12sqqae3msmf.cloudfront.net/myschoolone.com/1002/x.jpeg");
    assert.equal(seen[1].cookie, "cf=edge"); // only the CloudFront cookie on the CDN
  } finally {
    globalThis.fetch = realFetch;
  }
});
