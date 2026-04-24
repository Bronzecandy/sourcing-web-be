import { Router } from "express";
import { gameService } from "../services/game.service";
import type { RankingQuery } from "../types";

const router = Router();

router.get("/dashboard", async (_req, res) => {
  const stats = await gameService.getDashboardStats();
  res.json({ success: true, data: stats });
});

router.get("/rankings", async (req, res) => {
  const query: RankingQuery = {
    page: String(req.query.page ?? ""),
    limit: String(req.query.limit ?? ""),
    date: String(req.query.date ?? ""),
    sort: String(req.query.sort ?? ""),
    order: (req.query.order as "asc" | "desc") || undefined,
    search: String(req.query.search ?? ""),
    tag: String(req.query.tag ?? ""),
    platform: (req.query.platform as "android" | "ios") || undefined,
  };
  const result = await gameService.getRankings(query);
  res.json({ success: true, ...result });
});

router.get("/dates", async (_req, res) => {
  const dates = await gameService.getAvailableDates();
  res.json({ success: true, data: dates });
});

router.get("/tags", async (req, res) => {
  const date = req.query.date ? String(req.query.date) : undefined;
  const tags = await gameService.getTags(date);
  res.json({ success: true, data: tags });
});

router.get("/compare", async (req, res) => {
  const idsStr = String(req.query.ids ?? "");
  const ids = idsStr
    .split(",")
    .map(Number)
    .filter(Boolean);
  const days = parseInt(String(req.query.days ?? "30"));
  if (!ids || ids.length < 2) {
    res
      .status(400)
      .json({ success: false, error: "Provide at least 2 app ids" });
    return;
  }
  const result = await gameService.compareGames(ids, days);
  res.json({ success: true, data: result });
});

router.get("/:appId", async (req, res) => {
  const appId = parseInt(String(req.params.appId));
  const days = parseInt(String(req.query.days ?? "30"));
  const contentLang = String(req.query.contentLang ?? "vi") === "en" ? "en" : "vi";
  const game = await gameService.getGameDetail(appId, days, contentLang);
  if (!game) {
    res.status(404).json({ success: false, error: "Game not found" });
    return;
  }
  res.json({ success: true, data: game });
});

router.get("/:appId/reviews", async (req, res) => {
  const appId = parseInt(String(req.params.appId));
  const page = parseInt(String(req.query.page ?? "1"));
  const limit = parseInt(String(req.query.limit ?? "20"));
  const result = await gameService.getGameReviews(appId, page, limit);
  res.json({ success: true, ...result });
});

export default router;
