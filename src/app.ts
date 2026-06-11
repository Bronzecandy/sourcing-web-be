import express from "express";
import path from "path";
import cors from "cors";
import cookieParser from "cookie-parser";
import gameRoutes from "./routes/game.routes";
import translateRoutes from "./routes/translate.routes";
import rankingRoutes from "./routes/ranking.routes";
import analysisRoutes from "./routes/analysis.routes";
import librariesRoutes from "./routes/libraries.routes";
import analyticsRoutes from "./routes/analytics.routes";
import authRoutes from "./routes/auth.routes";
import adminRoutes from "./routes/admin.routes";
import { errorHandler } from "./middleware/error-handler";
import { precomputeAll } from "./precompute";
import { cache } from "./utils/cache";
import { attachAuth, apiPermissionGuard } from "./middleware/auth";

const app = express();

function resolveCorsOrigin(): string | string[] {
  const raw = process.env.CORS_ORIGIN?.trim() || "http://localhost:5173";
  if (raw.includes(",")) {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return raw;
}

app.use(
  cors({
    origin: resolveCorsOrigin(),
    credentials: true,
  }),
);
app.use(cookieParser());
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

app.use("/api/auth", authRoutes);
app.use("/api/admin", attachAuth, adminRoutes);

app.use("/api", attachAuth, apiPermissionGuard);

app.use("/api/translate", translateRoutes);
app.use("/api/games", gameRoutes);
app.use("/api/ranking", rankingRoutes);
app.use("/api/analysis", analysisRoutes);
app.use("/api/libraries", librariesRoutes);
app.use("/api/analytics", analyticsRoutes);

app.get("/admin/libraries", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "admin", "libraries.html"));
});

app.use(express.static(path.join(process.cwd(), "public")));

app.use(errorHandler);

export default app;
