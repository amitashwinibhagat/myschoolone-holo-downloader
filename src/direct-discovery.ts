import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { config } from "./config.js";

export interface RequestParameter {
  name: string;
  value: string;
}

export interface DiscoveredRequest {
  method: string;
  path: string;
  queryParameters: RequestParameter[];
  bodyParameters: RequestParameter[];
  resourceType: string;
  status: number;
  contentType: string;
}

export interface DiscoveryFile {
  capturedAt: string;
  requests: DiscoveredRequest[];
}

function parseParameters(postData: string | null): RequestParameter[] {
  if (!postData) return [];
  try {
    const json = JSON.parse(postData);
    if (json && typeof json === "object" && !Array.isArray(json)) {
      return Object.entries(json)
        .map(([name, value]) => ({ name, value: String(value) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
  } catch {
    // Not JSON — treat as form-encoded.
  }
  return [...new URLSearchParams(postData).entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Captures only request structure after a successful browser session.
 * Parameter names and values (dates, type codes) are recorded so the direct
 * HTTP path can replay the exact calls. Cookies, headers, response bodies, and
 * portal content are deliberately omitted.
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
      queryParameters: [...url.searchParams.entries()]
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      bodyParameters: parseParameters(request.postData()),
      resourceType: request.resourceType(),
      status: response.status(),
      contentType: response.headers()["content-type"] || "",
    };
    requests.set(
      `${record.method} ${record.path} ${record.queryParameters.map((p) => p.name).join(",")} ${record.bodyParameters.map((p) => p.name).join(",")}`,
      record,
    );
  };

  page.on("response", onResponse);
  return async () => {
    page.off("response", onResponse);
    if (requests.size === 0) return;
    await fs.mkdir(path.dirname(config.directDiscoveryPath), { recursive: true });
    const payload: DiscoveryFile = { capturedAt: new Date().toISOString(), requests: [...requests.values()] };
    const temp = `${config.directDiscoveryPath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    await fs.rename(temp, config.directDiscoveryPath);
  };
}

function normalizeParameters(params: unknown): RequestParameter[] {
  if (!Array.isArray(params)) return [];
  return params.map((entry) => {
    if (typeof entry === "string") return { name: entry, value: "" }; // legacy format
    if (entry && typeof entry === "object") {
      const obj = entry as { name?: unknown; value?: unknown };
      return { name: String(obj.name ?? ""), value: String(obj.value ?? "") };
    }
    return { name: String(entry), value: "" };
  });
}

/**
 * Load the raw discovery file (with capturedAt) or null when absent/corrupt.
 * Legacy files that recorded parameter names as plain strings are normalized.
 */
export async function loadDiscoveryFile(): Promise<DiscoveryFile | null> {
  let raw: string;
  try {
    raw = await fs.readFile(config.directDiscoveryPath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as {
      capturedAt?: string;
      requests?: Array<{
        method?: string;
        path?: string;
        queryParameters?: unknown;
        bodyParameters?: unknown;
        resourceType?: string;
        status?: number;
        contentType?: string;
      }>;
    };
    if (!Array.isArray(parsed.requests)) return null;
    const file: DiscoveryFile = {
      capturedAt: typeof parsed.capturedAt === "string" ? parsed.capturedAt : new Date().toISOString(),
      requests: parsed.requests
        .filter((r) => r && typeof r === "object")
        .map((r) => ({
          method: String(r.method ?? ""),
          path: String(r.path ?? ""),
          queryParameters: normalizeParameters(r.queryParameters),
          bodyParameters: normalizeParameters(r.bodyParameters),
          resourceType: String(r.resourceType ?? ""),
          status: Number(r.status ?? 0),
          contentType: String(r.contentType ?? ""),
        })),
    };
    return file;
  } catch {
    return null;
  }
}

/** Matches portal (DD/MM/YYYY) or ISO (YYYY-MM-DD) date-shaped parameter values. */
export const DATE_VALUE_PATTERN = /^(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{1,2}-\d{1,2})$/;
