import { Router } from "express";
import multer from "multer";
import { aiAnalysisService } from "../services/ai-analysis.service";
import {
  parseAppIdFromInput,
  fetchAppInfo,
  fetchExternalReviews,
  fetchAppDetailRaw,
  type ExternalReview,
} from "../services/taptap-client.service";
import { parseCsvBuffer } from "../utils/csv-parser";
import {
  parseReviewWindow,
  filterReviewsByWindow,
  emptyReviewWindowMessage,
} from "../utils/review-window";
import {
  useTapTapProxy,
  isTapTapProxyReachable,
  fetchTapTapViaProxy,
  formatFetchError,
} from "../utils/taptap-proxy-fetch";
import {
  parseSteamAppIdFromInput,
  fetchSteamAppDetails,
  fetchSteamReviewsUpTo,
  buildSteamDetailRaw,
} from "../services/steam-client.service";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

/** Khi đã dùng proxy: mặc định không gọi TapTap trực tiếp từ BE (IP datacenter hay bị 403/405). Chỉ thử direct khi = 1/true. */
function allowDirectTapTapDetailFallback(): boolean {
  const v = process.env.TAPTAP_DIRECT_DETAIL_FALLBACK ?? "";
  return v === "1" || v.toLowerCase() === "true";
}

/** Proxy lỗi/timeout/không reach → gọi TapTap trực tiếp. */
async function fetchTapTapBundle(appId: number): Promise<{
  appInfo: { title: string; iconUrl: string | null };
  reviews: ExternalReview[];
  detailFromProxy: Record<string, unknown> | null;
  via: "proxy" | "direct";
}> {
  if (useTapTapProxy()) {
    const reachable = await isTapTapProxyReachable();
    if (!reachable) {
      console.warn(
        `[analyze-external] TapTap proxy not reachable (health check failed) — using direct TapTap for appId=${appId}`,
      );
    } else {
      try {
        const proxy = await fetchTapTapViaProxy(appId);
        return { ...proxy, via: "proxy" };
      } catch (err) {
        console.warn(
          `[analyze-external] TapTap proxy failed for appId=${appId} (${formatFetchError(err)}) — falling back to direct TapTap`,
        );
      }
    }
  } else {
    console.log(`[analyze-external] Direct TapTap fetch for appId=${appId} (proxy disabled or unset)`);
  }

  try {
    const appInfo = await fetchAppInfo(appId);
    const [reviews, detailRaw] = await Promise.all([
      fetchExternalReviews(appId),
      fetchAppDetailRaw(appId),
    ]);
    return {
      appInfo: { title: appInfo.title, iconUrl: appInfo.iconUrl },
      reviews,
      detailFromProxy: detailRaw,
      via: "direct",
    };
  } catch (err) {
    throw new Error(
      `TapTap direct fetch failed: ${formatFetchError(err)}. ` +
        "If you are behind a firewall, fix proxy access to Railway or use a VPN.",
    );
  }
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
    const reviewWindow = parseReviewWindow(req.body?.reviewWindow);
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

      const filteredSteam = filterReviewsByWindow(reviews, reviewWindow);
      if (filteredSteam.length === 0) {
        clearInterval(keepAlive);
        res.end(
          JSON.stringify({
            success: false,
            error:
              reviews.length === 0
                ? `No reviews found for "${gameName}" (Steam appId: ${steamAppId})`
                : emptyReviewWindowMessage(reviewWindow),
          }),
        );
        return;
      }

      const result = await aiAnalysisService.analyzeExternalReviews(
        steamAppId,
        gameName,
        iconUrl,
        filteredSteam,
        "steam",
        detailRaw,
        reviewWindow,
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

    const bundle = await fetchTapTapBundle(appId);
    const appTitle = bundle.appInfo.title;
    const appIcon = bundle.appInfo.iconUrl;
    const reviews = bundle.reviews;
    let detailRaw = bundle.detailFromProxy;
    if (bundle.via === "proxy") {
      console.log(`[analyze-external] TapTap data via proxy for appId=${appId}`);
    }

    const filteredTap = filterReviewsByWindow(reviews, reviewWindow);
    if (filteredTap.length === 0) {
      clearInterval(keepAlive);
      res.end(
        JSON.stringify({
          success: false,
          error:
            reviews.length === 0
              ? `No reviews found for "${appTitle}" (appId: ${appId})`
              : emptyReviewWindowMessage(reviewWindow),
        }),
      );
      return;
    }

    if (!detailRaw && bundle.via === "proxy") {
      if (!allowDirectTapTapDetailFallback()) {
        console.warn(
          `[analyze-external] No app/v4/detail from proxy for appId=${appId} — set TAPTAP_DIRECT_DETAIL_FALLBACK=1 to retry direct TapTap for metadata.`,
        );
      } else {
        detailRaw = await fetchAppDetailRaw(appId);
      }
    }
    if (!detailRaw) {
      const proxyNoDirect = bundle.via === "proxy" && !allowDirectTapTapDetailFallback();
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
      filteredTap,
      "external",
      detailRaw,
      reviewWindow,
    );

    clearInterval(keepAlive);
    res.end(JSON.stringify({ success: true, data: result }));
  } catch (err) {
    clearInterval(keepAlive);
    console.error("[analysis route] POST analyze-external:", err);
    const message = formatFetchError(err);
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

    const reviewWindow = parseReviewWindow(
      req.body?.reviewWindow ?? (req.query.reviewWindow as string | undefined),
    );
    const { reviews, gameName, appId } = parseCsvBuffer(req.file.buffer);

    const numericId = /^\d+$/.test(appId) ? Number(appId) : hashStringToNumber(appId);

    const filtered = filterReviewsByWindow(reviews, reviewWindow);
    if (filtered.length === 0) {
      clearInterval(keepAlive);
      res.end(
        JSON.stringify({
          success: false,
          error:
            reviews.length === 0
              ? "No valid reviews found in the uploaded file"
              : emptyReviewWindowMessage(reviewWindow),
        }),
      );
      return;
    }

    const result = await aiAnalysisService.analyzeExternalReviews(
      numericId,
      gameName,
      null,
      filtered,
      "csv-upload",
      null,
      reviewWindow,
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
    const reviewWindow = parseReviewWindow(req.body?.reviewWindow);
    const result = await aiAnalysisService.analyzeGameReviews(appId, reviewWindow);
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
