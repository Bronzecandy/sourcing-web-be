import "./load-env";
import cron from "node-cron";
import app from "./app";
import { precomputeAll } from "./precompute";

const PORT = parseInt(process.env.PORT || "3001");

async function runPrecompute(label: string) {
  console.log(`[${label}] Pre-computing all data...`);
  try {
    const { durationMs, keys } = await precomputeAll();
    console.log(`[${label}] Done in ${durationMs}ms (${keys} cache keys)`);
  } catch (err) {
    console.error(`[${label}] Failed:`, err);
  }
}

cron.schedule("15 10 * * *", () => runPrecompute("cron"), {
  timezone: "Asia/Ho_Chi_Minh",
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
  console.log(`Library admin UI: http://localhost:${PORT}/admin/libraries`);
  console.log(`AI model: ${process.env.OPENAI_MODEL ?? "(not set)"}`);
  console.log(`Cron: pre-compute daily at 10:15 Asia/Ho_Chi_Minh`);
  if (process.env.SKIP_WARMUP === "1") {
    console.log(`[warm-up] Skipped (SKIP_WARMUP=1)`);
  } else {
    runPrecompute("warm-up");
  }
});
