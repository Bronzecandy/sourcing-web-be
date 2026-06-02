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
import {
  wantsAnalysisStream,
  createAnalysisStreamWriter,
  streamProgressReporter,
} from "../utils/analysis-progress-stream";
import type { AuthedRequest } from "../middleware/auth";
import type { Response } from "express";

const router = Router();

function actorUserId(req: AuthedRequest, res: Response): string | null {
  const id = req.authUser?.id;
  if (!id) {
    res.status(401).json({ success: false, error: "Unauthorized", code: "UNAUTHORIZED" });
    return null;
  }
  return id;
}
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

router.get("/all", async (req: AuthedRequest, res) => {
  try {
    const userId = actorUserId(req, res);
    if (!userId) return;
    const all = await aiAnalysisService.getAllAnalyses(userId);
    res.json({ success: true, data: all });
  } catch (err) {
    console.error("[analysis route] GET all:", err);
    res.status(500).json({ success: false, error: "Failed to fetch analyses" });
  }
});

router.post("/analyze-external", async (req: AuthedRequest, res) => {
  const userId = actorUserId(req, res);
  if (!userId) return;
  const input = String(req.body?.input ?? "").trim();
  const platformRaw = String(req.body?.platform ?? "taptap").toLowerCase();
  const platform = platformRaw === "steam" ? "steam" : "taptap";
  const reviewWindow = parseReviewWindow(req.body?.reviewWindow);
  const stream = wantsAnalysisStream(req.body);

  if (stream) {
    const out = createAnalysisStreamWriter(res);
    const progress = streamProgressReporter((e) => out.report(e));
    try {
      if (!input) {
        out.fail("Missing input (URL or App ID)");
        return;
      }
      progress({ percent: 2, phase: "start", message: "Bắt đầu phân tích từ nguồn ngoài…" });

      if (platform === "steam") {
        const steamAppId = parseSteamAppIdFromInput(input);
        if (!steamAppId || steamAppId <= 0) {
          out.fail("Invalid Steam URL or App ID");
          return;
        }
        progress({ percent: 5, phase: "fetch", message: "Đang tải thông tin & bình luận Steam…" });
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
          out.fail(
            reviews.length === 0
              ? `No reviews found for "${gameName}"`
              : emptyReviewWindowMessage(reviewWindow),
          );
          return;
        }
        progress({
          percent: 10,
          phase: "fetch",
          message: `Đã tải ${filteredSteam.length} bình luận Steam — bắt đầu AI…`,
        });
        const result = await aiAnalysisService.analyzeExternalReviews(
          userId,
          steamAppId,
          gameName,
          iconUrl,
          filteredSteam,
          "steam",
          detailRaw,
          reviewWindow,
          progress,
          10,
        );
        out.done(result);
        return;
      }

      const appId = parseAppIdFromInput(input);
      if (!appId || appId <= 0) {
        out.fail("Invalid TapTap URL or App ID");
        return;
      }

      progress({ percent: 3, phase: "db_check", message: "Đang kiểm tra bình luận trong CSDL…" });
      const dbReviewCount = await aiAnalysisService.countDatabaseReviews(appId);
      if (dbReviewCount > 0) {
        progress({
          percent: 8,
          phase: "db",
          message: `Có ${dbReviewCount} bình luận trong CSDL — phân tích nhanh (không qua proxy)…`,
        });
        try {
          const result = await aiAnalysisService.analyzeGameReviews(
            userId,
            appId,
            reviewWindow,
            progress,
            8,
          );
          out.done(result);
          return;
        } catch (dbErr) {
          console.warn("[analyze-external] DB stream failed, fallback proxy:", dbErr);
          progress({
            percent: 8,
            phase: "fetch",
            message: "CSDL lỗi — chuyển sang tải TapTap qua proxy…",
          });
        }
      }

      progress({
        percent: 8,
        phase: "fetch",
        message: "Đang tải bình luận TapTap (proxy có thể mất vài phút)…",
      });
      const bundle = await fetchTapTapBundle(appId);
      progress({
        percent: 12,
        phase: "fetch",
        message: `Đã tải ${bundle.reviews.length} bình luận — đang lọc & phân tích…`,
      });

      const filteredTap = filterReviewsByWindow(bundle.reviews, reviewWindow);
      if (filteredTap.length === 0) {
        out.fail(
          bundle.reviews.length === 0
            ? `No reviews found for "${bundle.appInfo.title}"`
            : emptyReviewWindowMessage(reviewWindow),
        );
        return;
      }

      let detailRaw = bundle.detailFromProxy;
      if (!detailRaw && bundle.via === "proxy" && allowDirectTapTapDetailFallback()) {
        detailRaw = await fetchAppDetailRaw(appId);
      }

      const result = await aiAnalysisService.analyzeExternalReviews(
        userId,
        appId,
        bundle.appInfo.title,
        bundle.appInfo.iconUrl,
        filteredTap,
        "external",
        detailRaw,
        reviewWindow,
        progress,
        12,
      );
      out.done(result);
    } catch (err) {
      console.error("[analysis route] POST analyze-external (stream):", err);
      out.fail(formatFetchError(err));
    }
    return;
  }

  const keepAlive = startKeepAlive(res);
  try {
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
        userId,
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

    const dbReviewCount = await aiAnalysisService.countDatabaseReviews(appId);
    if (dbReviewCount > 0) {
      console.log(
        `[analyze-external] appId=${appId}: ${dbReviewCount} reviews in DB — skipping TapTap proxy`,
      );
      try {
        const result = await aiAnalysisService.analyzeGameReviews(userId, appId, reviewWindow);
        clearInterval(keepAlive);
        res.end(JSON.stringify({ success: true, data: result }));
        return;
      } catch (dbErr) {
        console.warn(
          `[analyze-external] DB analysis failed for appId=${appId}, falling back to proxy:`,
          dbErr instanceof Error ? dbErr.message : dbErr,
        );
      }
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
      userId,
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

router.post("/analyze-csv", upload.single("file"), async (req: AuthedRequest, res) => {
  const userId = actorUserId(req, res);
  if (!userId) return;
  const reviewWindow = parseReviewWindow(
    req.body?.reviewWindow ?? (req.query.reviewWindow as string | undefined),
  );
  const stream =
    req.body?.stream === "true" ||
    req.body?.stream === true ||
    wantsAnalysisStream(req.body);

  if (stream) {
    const out = createAnalysisStreamWriter(res);
    const progress = streamProgressReporter((e) => out.report(e));
    try {
      if (!req.file) {
        out.fail("No file uploaded");
        return;
      }
      progress({ percent: 2, phase: "parse", message: "Đang đọc file bình luận…" });
      const { reviews, gameName, appId } = parseCsvBuffer(req.file.buffer);
      const numericId = /^\d+$/.test(appId) ? Number(appId) : hashStringToNumber(appId);
      const filtered = filterReviewsByWindow(reviews, reviewWindow);
      if (filtered.length === 0) {
        out.fail(
          reviews.length === 0
            ? "No valid reviews found in the uploaded file"
            : emptyReviewWindowMessage(reviewWindow),
        );
        return;
      }
      progress({
        percent: 8,
        phase: "parse",
        message: `${filtered.length} bình luận hợp lệ — bắt đầu AI…`,
      });
      const result = await aiAnalysisService.analyzeExternalReviews(
        userId,
        numericId,
        gameName,
        null,
        filtered,
        "csv-upload",
        null,
        reviewWindow,
        progress,
        8,
      );
      out.done(result);
    } catch (err) {
      console.error("[analysis route] POST analyze-csv (stream):", err);
      out.fail(err instanceof Error ? err.message : "CSV analysis failed");
    }
    return;
  }

  const keepAlive = startKeepAlive(res);
  try {
    if (!req.file) {
      clearInterval(keepAlive);
      res.end(JSON.stringify({ success: false, error: "No file uploaded" }));
      return;
    }

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
      userId,
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

router.post("/analyze/:appId", async (req: AuthedRequest, res) => {
  const userId = actorUserId(req, res);
  if (!userId) return;
  const appId = parseInt(String(req.params.appId));
  const reviewWindow = parseReviewWindow(req.body?.reviewWindow);

  if (wantsAnalysisStream(req.body)) {
    const out = createAnalysisStreamWriter(res);
    const progress = streamProgressReporter((e) => out.report(e));
    try {
      progress({ percent: 1, phase: "start", message: "Bắt đầu phân tích AI…" });
      const result = await aiAnalysisService.analyzeGameReviews(
        userId,
        appId,
        reviewWindow,
        progress,
      );
      out.done(result);
    } catch (err) {
      console.error("[analysis route] POST analyze (stream):", err);
      out.fail(err instanceof Error ? err.message : "Analysis failed");
    }
    return;
  }

  const keepAlive = startKeepAlive(res);
  try {
    const result = await aiAnalysisService.analyzeGameReviews(userId, appId, reviewWindow);
    clearInterval(keepAlive);
    res.end(JSON.stringify({ success: true, data: result }));
  } catch (err) {
    clearInterval(keepAlive);
    console.error("[analysis route] POST analyze:", err);
    const message = err instanceof Error ? err.message : "Analysis failed";
    res.end(JSON.stringify({ success: false, error: message }));
  }
});

router.get("/:appId", async (req: AuthedRequest, res) => {
  try {
    const userId = actorUserId(req, res);
    if (!userId) return;
    const appId = parseInt(String(req.params.appId));
    const result = await aiAnalysisService.getLatestAnalysis(userId, appId);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error("[analysis route] GET latest:", err);
    res.status(500).json({ success: false, error: "Failed to fetch analysis" });
  }
});

router.get("/:appId/history", async (req: AuthedRequest, res) => {
  try {
    const userId = actorUserId(req, res);
    if (!userId) return;
    const appId = parseInt(String(req.params.appId));
    const history = await aiAnalysisService.getAnalysisHistory(userId, appId);
    res.json({ success: true, data: history });
  } catch (err) {
    console.error("[analysis route] GET history:", err);
    res.status(500).json({ success: false, error: "Failed to fetch history" });
  }
});

router.delete("/:appId", async (req: AuthedRequest, res) => {
  try {
    const userId = actorUserId(req, res);
    if (!userId) return;
    const appId = parseInt(String(req.params.appId));
    const analyzedAt = String(req.query.analyzedAt ?? "");
    if (analyzedAt) {
      const ok = await aiAnalysisService.deleteAnalysis(userId, appId, analyzedAt);
      res.json({ success: true, deleted: ok ? 1 : 0 });
    } else {
      const count = await aiAnalysisService.deleteAllAnalyses(userId, appId);
      res.json({ success: true, deleted: count });
    }
  } catch (err) {
    console.error("[analysis route] DELETE:", err);
    res.status(500).json({ success: false, error: "Failed to delete" });
  }
});

export default router;
