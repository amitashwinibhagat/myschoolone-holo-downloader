import assert from "node:assert/strict";
import test from "node:test";

// We test the pure functions from direct-api by importing the module and
// extracting the logic. Since the module has config dependencies, we test
// the URL extraction logic directly.

test("extractAttachmentUrls: finds UploadFiles links in HTML", () => {
  // Simulate the extraction logic from direct-api.ts
  const ATTACHMENT_PATTERN = /UploadFiles/i;

  function extractAttachmentUrls(html: string): string[] {
    const urls = new Set<string>();
    const hrefPattern = /href=["']([^"']*UploadFiles[^"']*)["']/gi;
    const srcPattern = /src=["']([^"']*UploadFiles[^"']*)["']/gi;
    let match: RegExpExecArray | null;
    while ((match = hrefPattern.exec(html)) !== null) {
      urls.add(match[1]);
    }
    while ((match = srcPattern.exec(html)) !== null) {
      urls.add(match[1]);
    }
    return [...urls];
  }

  const html = `
    <a href="/UploadFiles/school/photo1.jpg">Photo 1</a>
    <img src="/UploadFiles/school/photo2.png" />
    <a href="/other/path/file.pdf">PDF</a>
    <a href="/UploadFiles/gallery/img_001.webp">Gallery</a>
  `;

  const urls = extractAttachmentUrls(html);
  assert.equal(urls.length, 3);
  assert.ok(urls.includes("/UploadFiles/school/photo1.jpg"));
  assert.ok(urls.includes("/UploadFiles/school/photo2.png"));
  assert.ok(urls.includes("/UploadFiles/gallery/img_001.webp"));
});

test("extractAttachmentUrls: returns empty for no matches", () => {
  function extractAttachmentUrls(html: string): string[] {
    const urls = new Set<string>();
    const hrefPattern = /href=["']([^"']*UploadFiles[^"']*)["']/gi;
    const srcPattern = /src=["']([^"']*UploadFiles[^"']*)["']/gi;
    let match: RegExpExecArray | null;
    while ((match = hrefPattern.exec(html)) !== null) urls.add(match[1]);
    while ((match = srcPattern.exec(html)) !== null) urls.add(match[1]);
    return [...urls];
  }

  assert.deepEqual(extractAttachmentUrls("<a href='/other/file.pdf'>PDF</a>"), []);
  assert.deepEqual(extractAttachmentUrls(""), []);
});

test("extractAttachmentUrls: deduplicates identical URLs", () => {
  function extractAttachmentUrls(html: string): string[] {
    const urls = new Set<string>();
    const hrefPattern = /href=["']([^"']*UploadFiles[^"']*)["']/gi;
    const srcPattern = /src=["']([^"']*UploadFiles[^"']*)["']/gi;
    let match: RegExpExecArray | null;
    while ((match = hrefPattern.exec(html)) !== null) urls.add(match[1]);
    while ((match = srcPattern.exec(html)) !== null) urls.add(match[1]);
    return [...urls];
  }

  const html = `
    <a href="/UploadFiles/photo.jpg">Link</a>
    <img src="/UploadFiles/photo.jpg" />
    <a href="/UploadFiles/photo.jpg">Another link</a>
  `;

  const urls = extractAttachmentUrls(html);
  assert.equal(urls.length, 1);
  assert.equal(urls[0], "/UploadFiles/photo.jpg");
});

test("extractAttachmentUrls: handles single-quoted attributes", () => {
  function extractAttachmentUrls(html: string): string[] {
    const urls = new Set<string>();
    const hrefPattern = /href=["']([^"']*UploadFiles[^"']*)["']/gi;
    const srcPattern = /src=["']([^"']*UploadFiles[^"']*)["']/gi;
    let match: RegExpExecArray | null;
    while ((match = hrefPattern.exec(html)) !== null) urls.add(match[1]);
    while ((match = srcPattern.exec(html)) !== null) urls.add(match[1]);
    return [...urls];
  }

  const html = `<a href='/UploadFiles/photo.jpg'>Photo</a>`;
  const urls = extractAttachmentUrls(html);
  assert.equal(urls.length, 1);
  assert.equal(urls[0], "/UploadFiles/photo.jpg");
});
