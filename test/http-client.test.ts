import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  hostMatchesDomain,
  buildCookieHeader,
  nextRedirectRequest,
  sessionExpiresWithin,
  type Cookie,
} from "../src/http-client.js";

function cookie(overrides: Partial<Cookie> = {}): Cookie {
  return { name: "sid", value: "abc123", domain: "school.example.com", path: "/", ...overrides };
}

test("http-client: hostMatchesDomain matches exact host and subdomains", () => {
  assert.equal(hostMatchesDomain("school.example.com", "school.example.com"), true);
  assert.equal(hostMatchesDomain("SCHOOL.EXAMPLE.COM", "school.example.com"), true);
  assert.equal(hostMatchesDomain("uploads.school.example.com", ".school.example.com"), true);
  assert.equal(hostMatchesDomain("evilschool.example.com", ".school.example.com"), false);
  assert.equal(hostMatchesDomain("school.example.com.evil.net", ".school.example.com"), false);
});

test("http-client: buildCookieHeader matches domain and path", () => {
  const cookies: Cookie[] = [
    cookie({ name: "a", value: "1", domain: "school.example.com", path: "/Web" }),
    cookie({ name: "b", value: "2", domain: ".school.example.com", path: "/" }),
    cookie({ name: "c", value: "3", domain: "other.example.com", path: "/" }),
  ];

  const header = buildCookieHeader(cookies, new URL("https://school.example.com/Web/planner.php"));
  assert.equal(header, "a=1; b=2");
});

test("http-client: nextRedirectRequest limits redirect hops", () => {
  const allowed = (url: URL) => url.hostname === "school.example.com";
  const next = nextRedirectRequest(
    302,
    "/next",
    "https://school.example.com/start",
    allowed,
    5,
    5,
    "GET",
    undefined,
  );
  assert.equal(next, null);
});

test("http-client: nextRedirectRequest turns 302 into bodyless GET", () => {
  const allowed = (url: URL) => url.hostname === "school.example.com";
  const next = nextRedirectRequest(
    302,
    "/login",
    "https://school.example.com/post",
    allowed,
    0,
    5,
    "POST",
    "body",
  );
  assert.deepEqual(next, {
    url: "https://school.example.com/login",
    method: "GET",
    body: undefined,
  });
});

test("http-client: sessionExpiresWithin flags cookies near expiry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "myschoolone-http-test-"));
  const statePath = path.join(root, "storage-state.json");
  const nearExpirySeconds = Math.floor((Date.now() + 10_000) / 1000);
  await fs.writeFile(
    statePath,
    JSON.stringify({
      cookies: [{ name: "session", value: "xyz", domain: "school.example.com", path: "/", expires: nearExpirySeconds }],
    }),
  );

  const expiresSoon = await sessionExpiresWithin(60_000, statePath);
  assert.equal(expiresSoon, true);

  const expiresFar = await sessionExpiresWithin(5_000, statePath);
  assert.equal(expiresFar, false);

  await fs.rm(root, { recursive: true, force: true });
});
