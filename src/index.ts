import "./load-env";
import cron from "node-cron";
import app from "./app";
import { precomputeAll } from "./precompute";
import { warmLibraryCache } from "./services/library-store";
import { installProcessDiagnostics, logDiag, logDiagError } from "./utils/process-diagnostics";

installProcessDiagnostics();

const PORT = parseInt(process.env.PORT || "3001");

async function warmAppDb(): Promise<void> {
  if (!process.env.DATABASE_URL_APP) {
    console.warn("[app-db] DATABASE_URL_APP not set — libraries/auth use app DB");
    return;
  }
  try {
    await warmLibraryCache();
    console.log("[app-db] Library + rubric cache warmed");
  } catch (err) {
    console.warn("[app-db] Cache warm failed (run seed:app?):", (err as Error).message);
  }
}

async function runPrecompute(label: string) {
  console.log(`[${label}] Pre-computing all data...`);
  logDiag("precompute-start", { label });
  try {
    const { durationMs, keys } = await precomputeAll();
    console.log(`[${label}] Done in ${durationMs}ms (${keys} cache keys)`);
    logDiag("precompute-done", { label, durationMs, keys });
  } catch (err) {
    console.error(`[${label}] Failed:`, err);
    logDiagError("precompute-failed", err, { label });
  }
}

cron.schedule("15 10 * * *", () => runPrecompute("cron"), {
  timezone: "Asia/Ho_Chi_Minh",
});

app.listen(PORT, async () => {
  await warmAppDb();
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
  console.log(`Library admin UI: http://localhost:${PORT}/admin/libraries`);
  console.log(`AI model: ${process.env.OPENAI_MODEL ?? "(not set)"}`);
  console.log(`Cron: pre-compute daily at 10:15 Asia/Ho_Chi_Minh`);
  logDiag("server-listening", {
    port: PORT,
    skipWarmup: process.env.SKIP_WARMUP === "1",
    pgPoolMax: process.env.PG_POOL_MAX ?? "25",
    precomputeDbConcurrency: process.env.PRECOMPUTE_DB_CONCURRENCY ?? "8",
    nodeEnv: process.env.NODE_ENV ?? "(unset)",
  });
  if (process.env.SKIP_WARMUP === "1") {
    console.log(`[warm-up] Skipped (SKIP_WARMUP=1)`);
  } else {
    const defaultDelay = process.env.NODE_ENV === "development" ? 120_000 : 0;
    const startDelay = Math.max(
      0,
      parseInt(process.env.PRECOMPUTE_START_DELAY_MS ?? String(defaultDelay), 10) || 0,
    );
    if (startDelay > 0) {
      console.log(`[warm-up] Scheduled in ${Math.round(startDelay / 1000)}s (PRECOMPUTE_START_DELAY_MS)`);
      setTimeout(() => runPrecompute("warm-up"), startDelay);
    } else {
      runPrecompute("warm-up");
    }
  }
});
