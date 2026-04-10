import { Router } from "express";
import { rankingService } from "../services/ranking.service";

const router = Router();

router.get("/potential", async (req, res) => {
  const days = parseInt(String(req.query.days ?? "14"));
  const platform = (req.query.platform as "combined" | "android" | "ios") || "combined";
  const scores = await rankingService.calculatePotentialScores(days, platform);
  res.json({ success: true, data: scores });
});

router.get("/potential/:appId", async (req, res) => {
  const appId = parseInt(req.params.appId);
  const days = parseInt(String(req.query.days ?? "14"));
  const platform = (req.query.platform as "combined" | "android" | "ios") || "combined";
  const detail = await rankingService.getGamePotentialDetail(appId, days, platform);
  res.json({ success: true, data: detail });
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
  const games = await rankingService.detectBreakoutGames(
    days,
    threshold,
    platform
  );
  res.json({ success: true, data: games });
});

export default router;
