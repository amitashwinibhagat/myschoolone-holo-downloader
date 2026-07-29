import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { config } from "./config.js";

interface DiscoveredRequest {
  method: string;
  path: string;
  queryParameters: string[];
  bodyParameters: string[];
  resourceType: string;
  status: number;
  contentType: string;
}

function bodyParameterNames(postData: string | null): string[] {
  if (!postData) return [];
  try {
    const json = JSON.parse(postData);
    return json && typeof json === "object" && !Array.isArray(json) ? Object.keys(json).sort() : [];
  } catch {
    return [...new URLSearchParams(postData).keys()].sort();
  }
}

/**
 * Captures only request structure after a successful browser session. Values,
 * cookies, headers, response bodies, and portal content are deliberately omitted.
 */
export function observeDailyLogRequests(page: Page): () => Promise<void> {
  const requests = new Map<string, DiscoveredRequest>();
  const schoolOrigin = new URL(config.schoolUrl).origin;

  const onResponse = (response: Awaited<ReturnType<Page["waitForResponse"]>>) => {
    const request = response.request();
    if (!["xhr", "fetch"].includes(request.resourceType())) return;
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      return;
    }
    if (url.origin !== schoolOrigin) return;
    const record: DiscoveredRequest = {
      method: request.method(),
      path: url.pathname,
      queryParameters: [...url.searchParams.keys()].sort(),
      bodyParameters: bodyParameterNames(request.postData()),
      resourceType: request.resourceType(),
      status: response.status(),
      contentType: response.headers()["content-type"] || "",
    };
    requests.set(`${record.method} ${record.path} ${record.queryParameters.join(",")} ${record.bodyParameters.join(",")}`, record);
  };

  page.on("response", onResponse);
  return async () => {
    page.off("response", onResponse);
    if (requests.size === 0) return;
    await fs.mkdir(path.dirname(config.directDiscoveryPath), { recursive: true });
    await fs.writeFile(
      config.directDiscoveryPath,
      JSON.stringify({ capturedAt: new Date().toISOString(), requests: [...requests.values()] }, null, 2),
      { mode: 0o600 },
    );
  };
}
