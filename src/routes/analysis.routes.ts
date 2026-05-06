import { Router } from "express";
import multer from "multer";
import { aiAnalysisService } from "../services/ai-analysis.service";
import {
  parseAppIdFromInput,
  fetchAppInfo,
  fetchExternalReviews,
  fetchAppDetailRaw,
  pickTapTapDetailFromProxyBundle,
  type ExternalReview,
} from "../services/taptap-client.service";
import { parseCsvBuffer } from "../utils/csv-parser";
import {
  parseSteamAppIdFromInput,
  fetchSteamAppDetails,
  fetchSteamReviewsUpTo,
  buildSteamDetailRaw,
} from "../services/steam-client.service";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const TAPTAP_PROXY_URL = process.env.TAPTAP_PROXY_URL || "";
const TAPTAP_PROXY_KEY = process.env.TAPTAP_PROXY_KEY || "";

/** Khi đã dùng proxy: mặc định không gọi TapTap trực tiếp từ BE (IP datacenter hay bị 403/405). Chỉ thử direct khi = 1/true. */
function allowDirectTapTapDetailFallback(): boolean {
  const v = process.env.TAPTAP_DIRECT_DETAIL_FALLBACK ?? "";
  return v === "1" || v.toLowerCase() === "true";
}

/** Proxy flush space keep-alive trước JSON — parse an toàn hơn. */
function parseProxyFullJson(raw: string): { success?: boolean; data?: unknown; error?: string } {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as { success?: boolean; data?: unknown; error?: string };
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as {
        success?: boolean;
        data?: unknown;
        error?: string;
      };
    }
    throw new Error("Invalid JSON from TapTap proxy");
  }
}

async function fetchViaProxy(appId: number): Promise<{
  appInfo: { title: string; iconUrl: string | null };
  reviews: ExternalReview[];
  /** Snapshot app/v4/detail nếu proxy trả kèm — dùng khi backend không gọi trực tiếp TapTap CN được. */
  detailFromProxy: Record<string, unknown> | null;
}> {
  const url = `${TAPTAP_PROXY_URL}/api/full/${appId}`;
  const headers: Record<string, string> = {};
  if (TAPTAP_PROXY_KEY) headers["x-api-key"] = TAPTAP_PROXY_KEY;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(300_000) });
  const raw = await res.text();
  const json = parseProxyFullJson(raw);
  if (!json.success) throw new Error(json.error ?? "Proxy request failed");

  const data = json.data as {
    appInfo: { title: string; iconUrl: string | null };
    reviews: ExternalReview[];
  };
  const detailFromProxy = pickTapTapDetailFromProxyBundle(json.data);

  return {
    appInfo: data.appInfo,
    reviews: data.reviews,
    detailFromProxy,
  };
}

function useProxy(): boolean {
  return !!TAPTAP_PROXY_URL;
}

function hashStringToNumber(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function startKeepAlive(res: import("express").Response): NodeJS.Timeout {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  return setInterval(() => {
    res.write(" ");
  }, 10_000);
}

router.get("/all", async (_req, res) => {
  try {
    const all = aiAnalysisService.getAllAnalyses();
    res.json({ success: true, data: all });
  } catch (err) {
    console.error("[analysis route] GET all:", err);
    res.status(500).json({ success: false, error: "Failed to fetch analyses" });
  }
});

router.post("/analyze-external", async (req, res) => {
  const keepAlive = startKeepAlive(res);
  try {
    const input = String(req.body?.input ?? "").trim();
    const platformRaw = String(req.body?.platform ?? "taptap").toLowerCase();
    const platform = platformRaw === "steam" ? "steam" : "taptap";
    if (!input) {
      clearInterval(keepAlive);
      res.end(JSON.stringify({ success: false, error: "Missing input (URL or App ID)" }));
      return;
    }

    if (platform === "steam") {
      const steamAppId = parseSteamAppIdFromInput(input);
      if (!steamAppId || steamAppId <= 0) {
        clearInterval(keepAlive);
        res.end(
          JSON.stringify({
            success: false,
            error: "Invalid Steam URL or App ID (expected store.steampowered.com/app/NUMBER or numeric ID)",
          }),
        );
        return;
      }

      console.log(`[analyze-external] Steam platform appId=${steamAppId}`);

      const [appData, reviews] = await Promise.all([
        fetchSteamAppDetails(steamAppId),
        fetchSteamReviewsUpTo(steamAppId),
      ]);

      const gameName =
        appData && typeof appData.name === "string" && appData.name.trim()
          ? appData.name.trim()
          : `Steam App ${steamAppId}`;
      const iconUrl =
        appData && typeof appData.header_image === "string" ? appData.header_image : null;
      const detailRaw = appData ? buildSteamDetailRaw(appData, steamAppId) : null;

      if (reviews.length === 0) {
        clearInterval(keepAlive);
        res.end(
          JSON.stringify({
            success: false,
            error: `No reviews found for "${gameName}" (Steam appId: ${steamAppId})`,
          }),
        );
        return;
      }

      const result = await aiAnalysisService.analyzeExternalReviews(
        steamAppId,
        gameName,
        iconUrl,
        reviews,
        "steam",
        detailRaw,
      );

      clearInterval(keepAlive);
      res.end(JSON.stringify({ success: true, data: result }));
      return;
    }

    const appId = parseAppIdFromInput(input);
    if (!appId || appId <= 0) {
      clearInterval(keepAlive);
      res.end(JSON.stringify({ success: false, error: "Invalid TapTap URL or App ID" }));
      return;
    }

    let appTitle: string;
    let appIcon: string | null;
    let reviews: ExternalReview[];
    let detailRaw: Record<string, unknown> | null = null;

    if (useProxy()) {
      console.log(`[analyze-external] Using TapTap proxy for appId=${appId}`);
      const proxy = await fetchViaProxy(appId);
      appTitle = proxy.appInfo.title;
      appIcon = proxy.appInfo.iconUrl;
      reviews = proxy.reviews;
      detailRaw = proxy.detailFromProxy;
    } else {
      console.log(`[analyze-external] Direct TapTap fetch for appId=${appId}`);
      const appInfo = await fetchAppInfo(appId);
      appTitle = appInfo.title;
      appIcon = appInfo.iconUrl;
      reviews = await fetchExternalReviews(appId);
    }

    if (reviews.length === 0) {
      clearInterval(keepAlive);
      res.end(JSON.stringify({ success: false, error: `No reviews found for "${appTitle}" (appId: ${appId})` }));
      return;
    }

    if (!detailRaw) {
      if (useProxy() && !allowDirectTapTapDetailFallback()) {
        console.warn(
          `[analyze-external] No app/v4/detail from proxy for appId=${appId} — skipping direct TapTap (server IPs often get 403/405). Update taptap-proxy to return detailRaw in /api/full, or set TAPTAP_DIRECT_DETAIL_FALLBACK=1 to attempt direct fetch.`,
        );
      } else {
        detailRaw = await fetchAppDetailRaw(appId);
      }
    }
    if (!detailRaw) {
      const proxyNoDirect = useProxy() && !allowDirectTapTapDetailFallback();
      console.warn(
        proxyNoDirect
          ? `[analyze-external] No app/v4/detail for appId=${appId} — analysis continues without TapTap metadata (deploy proxy with detailRaw in /api/full).`
          : `[analyze-external] No app/v4/detail snapshot for appId=${appId} — developer/publisher/tags may be missing in prompt.`,
      );
    }

    const result = await aiAnalysisService.analyzeExternalReviews(
      appId,
      appTitle,
      appIcon,
      reviews,
      "external",
      detailRaw,
    );

    clearInterval(keepAlive);
    res.end(JSON.stringify({ success: true, data: result }));
  } catch (err) {
    clearInterval(keepAlive);
    console.error("[analysis route] POST analyze-external:", err);
    const message = err instanceof Error ? err.message : "External analysis failed";
    res.end(JSON.stringify({ success: false, error: message }));
  }
});

router.post("/analyze-csv", upload.single("file"), async (req, res) => {
  const keepAlive = startKeepAlive(res);
  try {
    if (!req.file) {
      clearInterval(keepAlive);
      res.end(JSON.stringify({ success: false, error: "No file uploaded" }));
      return;
    }

    const { reviews, gameName, appId } = parseCsvBuffer(req.file.buffer);

    const numericId = /^\d+$/.test(appId) ? Number(appId) : hashStringToNumber(appId);

    const result = await aiAnalysisService.analyzeExternalReviews(
      numericId,
      gameName,
      null,
      reviews,
      "csv-upload",
    );

    clearInterval(keepAlive);
    res.end(JSON.stringify({ success: true, data: result }));
  } catch (err) {
    clearInterval(keepAlive);
    console.error("[analysis route] POST analyze-csv:", err);
    const message = err instanceof Error ? err.message : "CSV analysis failed";
    res.end(JSON.stringify({ success: false, error: message }));
  }
});

router.post("/analyze/:appId", async (req, res) => {
  const keepAlive = startKeepAlive(res);
  try {
    const appId = parseInt(String(req.params.appId));
    const result = await aiAnalysisService.analyzeGameReviews(appId);
    clearInterval(keepAlive);
    res.end(JSON.stringify({ success: true, data: result }));
  } catch (err) {
    clearInterval(keepAlive);
    console.error("[analysis route] POST analyze:", err);
    const message = err instanceof Error ? err.message : "Analysis failed";
    res.end(JSON.stringify({ success: false, error: message }));
  }
});

router.get("/:appId", async (req, res) => {
  try {
    const appId = parseInt(String(req.params.appId));
    const result = aiAnalysisService.getLatestAnalysis(appId);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error("[analysis route] GET latest:", err);
    res.status(500).json({ success: false, error: "Failed to fetch analysis" });
  }
});

router.get("/:appId/history", async (req, res) => {
  try {
    const appId = parseInt(String(req.params.appId));
    const history = aiAnalysisService.getAnalysisHistory(appId);
    res.json({ success: true, data: history });
  } catch (err) {
    console.error("[analysis route] GET history:", err);
    res.status(500).json({ success: false, error: "Failed to fetch history" });
  }
});

router.delete("/:appId", async (req, res) => {
  try {
    const appId = parseInt(String(req.params.appId));
    const analyzedAt = String(req.query.analyzedAt ?? "");
    if (analyzedAt) {
      const ok = aiAnalysisService.deleteAnalysis(appId, analyzedAt);
      res.json({ success: true, deleted: ok ? 1 : 0 });
    } else {
      const count = aiAnalysisService.deleteAllAnalyses(appId);
      res.json({ success: true, deleted: count });
    }
  } catch (err) {
    console.error("[analysis route] DELETE:", err);
    res.status(500).json({ success: false, error: "Failed to delete" });
  }
});

export default router;
