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

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const TAPTAP_PROXY_URL = process.env.TAPTAP_PROXY_URL || "";
const TAPTAP_PROXY_KEY = process.env.TAPTAP_PROXY_KEY || "";

async function fetchViaProxy(appId: number): Promise<{
  appInfo: { title: string; iconUrl: string | null };
  reviews: ExternalReview[];
}> {
  const url = `${TAPTAP_PROXY_URL}/api/full/${appId}`;
  const headers: Record<string, string> = {};
  if (TAPTAP_PROXY_KEY) headers["x-api-key"] = TAPTAP_PROXY_KEY;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(300_000) });
  const raw = await res.text();
  const trimmed = raw.trim();
  const json = JSON.parse(trimmed);
  if (!json.success) throw new Error(json.error ?? "Proxy request failed");

  return {
    appInfo: {
      title: json.data.appInfo.title,
      iconUrl: json.data.appInfo.iconUrl,
    },
    reviews: json.data.reviews as ExternalReview[],
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
    if (!input) {
      clearInterval(keepAlive);
      res.end(JSON.stringify({ success: false, error: "Missing input (TapTap URL or App ID)" }));
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

    if (useProxy()) {
      console.log(`[analyze-external] Using TapTap proxy for appId=${appId}`);
      const proxy = await fetchViaProxy(appId);
      appTitle = proxy.appInfo.title;
      appIcon = proxy.appInfo.iconUrl;
      reviews = proxy.reviews;
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

    const detailRaw = await fetchAppDetailRaw(appId);

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
