import { fetchWithLongConnect } from "./fetch-external";
import { normalizeProxyBaseUrl, parseProxyResponseBody } from "./proxy-json";
import { pickTapTapDetailFromProxyBundle } from "../services/taptap-client.service";
import type { ExternalReview } from "../services/taptap-client.service";

const PROXY_BASE = normalizeProxyBaseUrl(process.env.TAPTAP_PROXY_URL || "");
const PROXY_KEY = process.env.TAPTAP_PROXY_KEY || "";

export function useTapTapProxy(): boolean {
  if (!PROXY_BASE) return false;
  const skip = process.env.TAPTAP_SKIP_PROXY ?? "";
  return skip !== "1" && skip.toLowerCase() !== "true";
}

function proxyHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  if (PROXY_KEY) h["x-api-key"] = PROXY_KEY;
  return h;
}

/** Ping nhanh — tránh chờ connect 10s rồi mới fail trên /api/full. */
export async function isTapTapProxyReachable(): Promise<boolean> {
  if (!PROXY_BASE) return false;
  try {
    const res = await fetchWithLongConnect(`${PROXY_BASE}/health`, {
      headers: proxyHeaders(),
      signal: AbortSignal.timeout(25_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchTapTapViaProxy(appId: number): Promise<{
  appInfo: { title: string; iconUrl: string | null };
  reviews: ExternalReview[];
  detailFromProxy: Record<string, unknown> | null;
}> {
  const url = `${PROXY_BASE}/api/full/${appId}`;
  const res = await fetchWithLongConnect(url, {
    headers: proxyHeaders(),
    signal: AbortSignal.timeout(600_000),
  });
  const raw = await res.text();

  if (!res.ok) {
    let errMsg = `TapTap proxy HTTP ${res.status}`;
    try {
      const errJson = parseProxyResponseBody(raw, "TapTap proxy error");
      if (errJson.error) errMsg = String(errJson.error);
    } catch {
      if (raw.trim()) errMsg += ` — ${raw.trim().slice(0, 200)}`;
    }
    throw new Error(errMsg);
  }

  const json = parseProxyResponseBody(raw, "TapTap proxy");
  if (!json.success) throw new Error(String(json.error ?? "Proxy request failed"));

  const data = json.data as {
    appInfo?: { title: string; iconUrl: string | null };
    reviews?: ExternalReview[];
  };
  if (!data?.appInfo || !Array.isArray(data.reviews)) {
    throw new Error("TapTap proxy response missing appInfo or reviews");
  }

  return {
    appInfo: data.appInfo,
    reviews: data.reviews,
    detailFromProxy: pickTapTapDetailFromProxyBundle(json.data),
  };
}

export function formatFetchError(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause as { code?: string } | undefined;
    if (cause?.code === "UND_ERR_CONNECT_TIMEOUT") {
      return (
        "Không kết nối được TapTap proxy (Railway) trong thời gian cho phép. " +
        "Mạng có thể chặn railway.app — hệ thống sẽ thử TapTap trực tiếp, hoặc tắt proxy (xóa TAPTAP_PROXY_URL / TAPTAP_SKIP_PROXY=1)."
      );
    }
    return err.message;
  }
  return String(err);
}
