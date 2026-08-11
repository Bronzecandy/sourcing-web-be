import { Router } from "express";
import { rankingService } from "../services/ranking.service";

const router = Router();

function parseSegment(raw: unknown): "reserve" | "launched" {
  const s = String(raw ?? "reserve").toLowerCase();
  return s === "launched" ? "launched" : "reserve";
}

router.get("/potential", async (req, res) => {
  try {
    const days = parseInt(String(req.query.days ?? "14"));
    const platform = (req.query.platform as "combined" | "android" | "ios") || "combined";
    const segment = parseSegment(req.query.segment);
    const scores = await rankingService.calculatePotentialScores(days, platform, segment);
    res.json({ success: true, data: scores });
  } catch (err) {
    console.error("[ranking route] GET /potential:", err);
    const message = err instanceof Error ? err.message : "Failed to load potential";
    res.status(503).json({ success: false, error: message });
  }
});

router.get("/potential/:appId/breakdown", async (req, res) => {
  try {
    const appId = parseInt(req.params.appId);
    const days = parseInt(String(req.query.days ?? "14"));
    const platform = (req.query.platform as "combined" | "android" | "ios") || "combined";
    const data = await rankingService.getGamePotentialBreakdown(appId, days, platform);
    res.json({ success: true, data });
  } catch (err) {
    console.error("[ranking route] GET /potential/:appId/breakdown:", err);
    const message = err instanceof Error ? err.message : "Failed to load potential breakdown";
    res.status(503).json({ success: false, error: message });
  }
});

router.get("/potential/:appId", async (req, res) => {
  try {
    const appId = parseInt(req.params.appId);
    const days = parseInt(String(req.query.days ?? "14"));
    const platform = (req.query.platform as "combined" | "android" | "ios") || "combined";
    const segment = parseSegment(req.query.segment);
    const detail = await rankingService.getGamePotentialDetail(appId, days, platform, segment);
    res.json({ success: true, data: detail });
  } catch (err) {
    console.error("[ranking route] GET /potential/:appId:", err);
    const message = err instanceof Error ? err.message : "Failed to load potential detail";
    res.status(503).json({ success: false, error: message });
  }
});

router.get("/reserve-growth", async (req, res) => {
  const days = parseInt(String(req.query.days ?? "14"));
  const platform = (req.query.platform as "combined" | "android" | "ios") || "combined";
  const data = await rankingService.getTopReserveGrowth(days, platform);
  res.json({ success: true, data });
});

router.get("/breakout", async (req, res) => {
  const days = parseInt(String(req.query.days ?? "7"));
  const threshold = parseInt(String(req.query.threshold ?? "20"));
  const platform = (req.query.platform as "combined" | "android" | "ios") || "combined";
  const segment = parseSegment(req.query.segment);
  const games = await rankingService.detectBreakoutGames(
    days,
    threshold,
    platform,
    segment,
  );
  res.json({ success: true, data: games });
});

export default router;
