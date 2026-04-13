import { Router } from "express";
import { aiAnalysisService } from "../services/ai-analysis.service";
import {
  parseAppIdFromInput,
  fetchAppInfo,
  fetchExternalReviews,
} from "../services/taptap-client.service";

const router = Router();

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

    console.log(`[analyze-external] Fetching app info for appId=${appId}`);
    const appInfo = await fetchAppInfo(appId);

    console.log(`[analyze-external] Fetching reviews for "${appInfo.title}" (appId=${appId})`);
    const reviews = await fetchExternalReviews(appId);

    if (reviews.length === 0) {
      clearInterval(keepAlive);
      res.end(JSON.stringify({ success: false, error: `No reviews found for "${appInfo.title}" (appId: ${appId})` }));
      return;
    }

    const result = await aiAnalysisService.analyzeExternalReviews(
      appId,
      appInfo.title,
      appInfo.iconUrl,
      reviews,
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
