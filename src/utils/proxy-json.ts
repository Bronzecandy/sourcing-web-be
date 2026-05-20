import { jsonrepair } from "jsonrepair";

export type ProxyJsonEnvelope = { success?: boolean; data?: unknown; error?: string };

/** Tìm vị trí bắt đầu object JSON gốc (bỏ space keep-alive phía trước). */
function findJsonObjectStart(text: string): number {
  const markers = ['{"success"', '{"error"', "{\n", "{\r\n", "{"];
  let best = -1;
  for (const m of markers) {
    const i = text.indexOf(m);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  return best;
}

/** Cân ngoặc `{` `}` ngoài chuỗi JSON (xử lý escape cơ bản). */
function extractBalancedJsonObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse body từ taptap-proxy (có thể có space keep-alive trước JSON, hoặc JSON rất lớn).
 */
export function parseProxyResponseBody(raw: string, context = "TapTap proxy"): ProxyJsonEnvelope {
  const trimmed = raw.replace(/^\uFEFF/, "").trim();
  if (!trimmed) {
    throw new Error(
      `${context} returned an empty body (timeout or connection closed). Try a shorter review window or retry later.`,
    );
  }

  const attempts: string[] = [];
  const start = findJsonObjectStart(trimmed);
  if (start >= 0) {
    const balanced = extractBalancedJsonObject(trimmed, start);
    if (balanced) attempts.push(balanced);
    attempts.push(trimmed.slice(start));
  }
  attempts.push(trimmed);

  const seen = new Set<string>();
  let lastErr: unknown;
  for (const candidate of attempts) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    for (const text of [candidate, jsonrepair(candidate)]) {
      try {
        return JSON.parse(text) as ProxyJsonEnvelope;
      } catch (e) {
        lastErr = e;
      }
    }
  }

  const preview = trimmed.slice(0, 120).replace(/\s+/g, " ");
  throw new Error(
    `${context} returned invalid JSON (${preview}${trimmed.length > 120 ? "…" : ""}). ` +
      `Check TAPTAP_PROXY_URL / API key, or the proxy may have timed out while collecting reviews.`,
  );
}

export function normalizeProxyBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}
