import express from "express";
import cors from "cors";
import gameRoutes from "./routes/game.routes";
import rankingRoutes from "./routes/ranking.routes";
import analysisRoutes from "./routes/analysis.routes";
import { errorHandler } from "./middleware/error-handler";
import { precomputeAll } from "./precompute";
import { cache } from "./utils/cache";

const app = express();

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:5173",
    credentials: true,
  })
);
app.use(express.json());

app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.set("Pragma", "no-cache");
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    cacheKeys: cache.keys().length,
  });
});

app.post("/api/admin/refresh-cache", async (_req, res) => {
  const { durationMs, keys } = await precomputeAll();
  res.json({ success: true, durationMs, cacheKeys: keys });
});

app.use("/api/games", gameRoutes);
app.use("/api/ranking", rankingRoutes);
app.use("/api/analysis", analysisRoutes);

app.use(errorHandler);

export default app;
