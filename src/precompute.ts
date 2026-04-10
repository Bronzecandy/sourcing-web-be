import { cache, setForceRefresh } from "./utils/cache";
import { rankingService } from "./services/ranking.service";
import { gameService } from "./services/game.service";

const ALL_PLATFORMS = ["combined", "android", "ios"] as const;
const POTENTIAL_DAYS = [7, 14, 30];
const DETAIL_DAYS = [7, 14, 30, 60];

function isRetryableDbError(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  const msg = String((err as { message?: string }).message ?? "");
  return code === "40001" || code === "P2034" || code === "P1008"
    || msg.includes("timed out") || msg.includes("SocketTimeout")
    || msg.includes("ETIMEDOUT") || msg.includes("ECONNRESET");
}

async function retry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = 5,
  delayMs = 3000,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      if (!isRetryableDbError(err) || attempt === maxAttempts) throw err;
      const wait = delayMs * attempt;
      const code = (err as { code?: string }).code ?? "unknown";
      console.warn(`[precompute] ${label} attempt ${attempt}/${maxAttempts} failed (${code}), retrying in ${wait}ms...`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error("unreachable");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runSequential(tasks: Array<{ label: string; fn: () => Promise<unknown> }>) {
  for (const t of tasks) {
    await retry(t.fn, t.label);
  }
}

async function runBatch(tasks: Array<{ label: string; fn: () => Promise<unknown> }>) {
  await Promise.all(
    tasks.map((t) => retry(t.fn, t.label))
  );
}

async function collectTopAppIds(): Promise<number[]> {
  return retry(async () => {
    const result = await gameService.getRankings({ platform: "combined", page: "1", limit: "200" });
    return (result.data as Array<{ appId: number }>).map((g) => g.appId);
  }, "collectTopAppIds");
}

const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 500;

export async function precomputeAll(): Promise<{ durationMs: number; keys: number }> {
  const start = Date.now();
  setForceRefresh(true);

  try {
    // Phase 1: Dashboard + dates + tags + rankings — run sequentially to avoid overwhelming DB
    console.log("[precompute] Phase 1: Dashboard + Rankings...");
    await runSequential([
      { label: "dashboard", fn: () => gameService.getDashboardStats() },
      { label: "dates", fn: () => gameService.getAvailableDates() },
      { label: "tags", fn: () => gameService.getTags() },
      ...ALL_PLATFORMS.map((platform) => ({
        label: `rankings-${platform}`,
        fn: () => gameService.getRankings({ platform, page: "1", limit: "1" }),
      })),
    ]);

    // Phase 2: Potential analysis — sequential by platform to reduce DB pressure
    console.log("[precompute] Phase 2: Potential analysis...");
    for (const platform of ALL_PLATFORMS) {
      console.log(`[precompute]   platform=${platform}...`);
      await runSequential([
        ...POTENTIAL_DAYS.map((days) => ({
          label: `potential-${platform}-${days}`,
          fn: () => rankingService.calculatePotentialScores(days, platform),
        })),
        ...POTENTIAL_DAYS.map((days) => ({
          label: `breakout-${platform}-${days}`,
          fn: () => rankingService.detectBreakoutGames(days, 10, platform),
        })),
        ...POTENTIAL_DAYS.map((days) => ({
          label: `reserve-${platform}-${days}`,
          fn: () => rankingService.getTopReserveGrowth(days, platform),
        })),
      ]);
      await sleep(1000);
    }

    // Phase 3: Game details + potential details for top 200
    console.log("[precompute] Phase 3: Game details + potential details (top 200)...");
    const appIds = await collectTopAppIds();
    console.log(`[precompute] Pre-building for ${appIds.length} games (batch=${BATCH_SIZE})...`);

    for (let i = 0; i < appIds.length; i += BATCH_SIZE) {
      const batch = appIds.slice(i, i + BATCH_SIZE);
      const progress = `[${i + 1}-${Math.min(i + BATCH_SIZE, appIds.length)}/${appIds.length}]`;

      await runBatch(
        batch.flatMap((appId) => [
          ...DETAIL_DAYS.map((days) => ({
            label: `detail-${appId}-${days}d`,
            fn: () => gameService.getGameDetail(appId, days),
          })),
          ...POTENTIAL_DAYS.map((days) => ({
            label: `pot-detail-${appId}-${days}d`,
            fn: () => rankingService.getGamePotentialDetail(appId, days, "combined"),
          })),
        ])
      );

      if ((i / BATCH_SIZE) % 10 === 0) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(0);
        console.log(`[precompute] ${progress} done (${elapsed}s elapsed)`);
      }

      if (i + BATCH_SIZE < appIds.length) await sleep(BATCH_DELAY_MS);
    }

    const duration = Date.now() - start;
    console.log(`[precompute] All done in ${(duration / 1000).toFixed(1)}s (${cache.keys().length} keys cached)`);

    return { durationMs: duration, keys: cache.keys().length };
  } finally {
    setForceRefresh(false);
  }
}
