import { cache, cacheHas, pruneCacheKeyPrefix, setForceRefresh } from "./utils/cache";
import { waitForPrecomputeSlot } from "./utils/analysis-active-guard";
import { withDbRetry, type DbRetryOptions } from "./utils/db-retry";
import { logDiag, logDiagError } from "./utils/process-diagnostics";
import { runWithConcurrency } from "./utils/run-with-concurrency";
import { rankingService } from "./services/ranking.service";
import { gameService } from "./services/game.service";
import {
  DISTRIBUTION_META_CACHE_KEY,
  DISTRIBUTION_TABS,
  distributionOverviewCacheKey,
  distributionTrendsCacheKey,
  distributionService,
} from "./services/distribution.service";
import { refreshCohortStore } from "./services/distribution-cohort-store";
import { refreshPotentialScorers } from "./utils/distribution-percentile";
import type { DistributionTab } from "./types";
import { prisma } from "./utils/prisma";

const ALL_PLATFORMS = ["combined", "android", "ios"] as const;
const POTENTIAL_DAYS = [7, 14, 30];
const DETAIL_DAYS = [7, 14, 30, 60];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PRECOMPUTE_RETRY: DbRetryOptions = {
  maxAttempts: Math.max(1, parseInt(process.env.PRECOMPUTE_DB_MAX_ATTEMPTS ?? "5", 10) || 5),
  delayMs: Math.max(500, parseInt(process.env.PRECOMPUTE_DB_RETRY_DELAY_MS ?? "3000", 10) || 3000),
};

async function retry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  return withDbRetry(fn, label, PRECOMPUTE_RETRY);
}

/** On Neon 40001 / timeout: log and continue — never take down warm-up or the process. */
async function retrySoft<T>(fn: () => Promise<T>, label: string): Promise<T | null> {
  try {
    return await withDbRetry(fn, label, PRECOMPUTE_RETRY);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[precompute] SKIP ${label} after DB retries: ${message}`);
    logDiagError("precompute-task-skipped", err, { label });
    return null;
  }
}

async function runSequential(tasks: Array<{ label: string; fn: () => Promise<unknown> }>) {
  for (const t of tasks) {
    await waitForPrecomputeSlot();
    await retry(t.fn, t.label);
  }
}

const PRECOMPUTE_DB_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.PRECOMPUTE_DB_CONCURRENCY ?? "2", 10) || 2,
);

async function runBatch(tasks: Array<{ label: string; fn: () => Promise<unknown> }>) {
  await runWithConcurrency(
    tasks.map((t) => async () => {
      await waitForPrecomputeSlot();
      return retry(t.fn, t.label);
    }),
    PRECOMPUTE_DB_CONCURRENCY,
  );
}

async function collectTopAppIds(): Promise<number[]> {
  return retry(async () => {
    const result = await gameService.getRankings({ platform: "combined", page: "1", limit: "200" });
    return (result.data as Array<{ appId: number }>).map((g) => g.appId);
  }, "collectTopAppIds");
}

async function collectNewChartAppIds(withinDays = 14): Promise<number[]> {
  return retry(async () => {
    const cutoff = new Date();
    cutoff.setUTCHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - withinDays);
    const rows = await prisma.$queryRaw<{ appId: number }[]>`
      SELECT "appId"
      FROM "AppRank"
      GROUP BY "appId"
      HAVING MIN("date") >= ${cutoff}
    `;
    return rows.map((r) => r.appId);
  }, "collectNewChartAppIds");
}

async function collectLatestSnapshotAppIds(): Promise<number[]> {
  return retry(async () => {
    const latest = await prisma.appRank.aggregate({ _max: { date: true } });
    const d = latest._max.date;
    if (!d) return [];
    const rows = await prisma.appRank.findMany({
      where: { date: d },
      select: { appId: true },
      distinct: ["appId"],
    });
    return rows.map((r) => r.appId);
  }, "collectLatestSnapshotAppIds");
}

async function collectPrecomputeAppIds(): Promise<{ top: number[]; extra: number[] }> {
  const [top, newest, latestSnap] = await Promise.all([
    collectTopAppIds(),
    collectNewChartAppIds(14),
    collectLatestSnapshotAppIds(),
  ]);
  const topSet = new Set(top);
  const extra = [...new Set([...newest, ...latestSnap])].filter((id) => !topSet.has(id));
  const maxExtra = Math.max(0, parseInt(process.env.PRECOMPUTE_MAX_EXTRA_APPS ?? "150", 10) || 150);
  return { top, extra: extra.slice(0, maxExtra) };
}

function detailTasksForApp(appId: number, daysList: number[]) {
  return daysList.flatMap((days) => [
    {
      label: `detail-${appId}-${days}d`,
      fn: () => gameService.getGameDetail(appId, { kind: "days", days }),
    },
    {
      label: `pot-detail-${appId}-${days}d`,
      fn: () => rankingService.getGamePotentialDetail(appId, days, "combined"),
    },
    {
      label: `pot-breakdown-${appId}-${days}d`,
      fn: () => rankingService.getGamePotentialBreakdown(appId, days, "combined"),
    },
  ]);
}

const BATCH_SIZE = Math.max(1, parseInt(process.env.PRECOMPUTE_BATCH_SIZE ?? "20", 10) || 20);
const BATCH_DELAY_MS = Math.max(0, parseInt(process.env.PRECOMPUTE_BATCH_DELAY_MS ?? "50", 10) || 50);

const PRECOMPUTE_DISTRIBUTION_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.PRECOMPUTE_DISTRIBUTION_CONCURRENCY ?? "1", 10) || 1,
);

const PRECOMPUTE_DISTRIBUTION_TASK_DELAY_MS = Math.max(
  0,
  parseInt(process.env.PRECOMPUTE_DISTRIBUTION_TASK_DELAY_MS ?? "3000", 10) || 3000,
);

function isDistributionPrecomputeEnabled(): boolean {
  return process.env.PRECOMPUTE_DISTRIBUTION !== "0";
}

function shouldForceDistributionRefresh(label?: string): boolean {
  if (process.env.PRECOMPUTE_DISTRIBUTION_FORCE === "1") return true;
  if (process.env.PRECOMPUTE_DISTRIBUTION_FORCE === "0") return false;
  return label === "cron" || label === "admin-refresh";
}

/** warm-up: latest year(s) only; cron/admin: all years (optional cap via PRECOMPUTE_DISTRIBUTION_MAX_YEARS). */
function yearsForDistributionPrecompute(allYears: number[], label?: string): number[] {
  const sorted = [...allYears].sort((a, b) => b - a);
  const capAll = parseInt(process.env.PRECOMPUTE_DISTRIBUTION_MAX_YEARS ?? "0", 10) || 0;
  if (label === "cron" || label === "admin-refresh") {
    return capAll > 0 ? sorted.slice(0, capAll) : sorted;
  }
  const warmYears = Math.max(1, parseInt(process.env.PRECOMPUTE_DISTRIBUTION_WARMUP_YEARS ?? "1", 10) || 1);
  return sorted.slice(0, warmYears);
}

async function precomputeDistribution(options: { force: boolean; label?: string }): Promise<void> {
  if (!isDistributionPrecomputeEnabled()) {
    console.log("[precompute] Phase 4: Distribution skipped (PRECOMPUTE_DISTRIBUTION=0)");
    return;
  }

  const includeTrends = process.env.PRECOMPUTE_DISTRIBUTION_INCLUDE_TRENDS !== "0";
  const phaseStart = Date.now();
  console.log("[precompute] Phase 4: Distribution analytics (sequential, soft-fail on DB)...");

  setForceRefresh(false);
  try {
    await waitForPrecomputeSlot();
    console.log("[precompute]   refreshing distribution cohort store...");
    try {
      await refreshCohortStore();
    } catch (err) {
      console.warn("[precompute]   cohort store refresh failed:", (err as Error).message);
    }

    const meta = await distributionService.getMeta();
    const years = yearsForDistributionPrecompute(meta.years, options.label);
    if (years.length < meta.years.length) {
      console.log(
        `[precompute]   distribution years limited to [${years.join(", ")}] (label=${options.label ?? "warm-up"})`,
      );
    }

    type DistTask = {
      label: string;
      cacheKey: string;
      run: () => Promise<unknown>;
    };

    const tasks: DistTask[] = [];
    if (!options.force && cacheHas(DISTRIBUTION_META_CACHE_KEY)) {
      console.log("[precompute]   distribution meta cached");
    }

    for (const year of years) {
      for (const tab of DISTRIBUTION_TABS) {
        tasks.push({
          label: `distribution-overview-${year}-${tab}`,
          cacheKey: distributionOverviewCacheKey(year, tab),
          run: () => distributionService.getOverview({ year, lifecycle: tab }),
        });
        if (includeTrends) {
          tasks.push({
            label: `distribution-trends-${year}-${tab}`,
            cacheKey: distributionTrendsCacheKey(year, tab),
            run: () => distributionService.getTrends({ year, lifecycle: tab }),
          });
        }
      }
    }

    const includeAllTime =
      options.label === "cron" || options.label === "admin-refresh" || options.force;
    if (includeAllTime) {
      for (const tab of DISTRIBUTION_TABS) {
        tasks.push({
          label: `distribution-overview-all-${tab}`,
          cacheKey: distributionOverviewCacheKey(null, tab),
          run: () => distributionService.getOverview({ year: null, lifecycle: tab }),
        });
        if (includeTrends) {
          tasks.push({
            label: `distribution-trends-all-${tab}`,
            cacheKey: distributionTrendsCacheKey(null, tab),
            run: () => distributionService.getTrends({ year: null, lifecycle: tab }),
          });
        }
      }
    }

    let skipped = 0;
    let failed = 0;
    let built = 0;
    const failedTasks: DistTask[] = [];

    const runDistTasks = async (taskList: DistTask[], softFail: boolean) => {
      await runWithConcurrency(
        taskList.map((task) => async () => {
          if (!options.force && cacheHas(task.cacheKey)) {
            skipped += 1;
            return;
          }
          await waitForPrecomputeSlot();
          const t0 = Date.now();
          const ok = softFail ? await retrySoft(task.run, task.label) : await retry(task.run, task.label);
          const ms = Date.now() - t0;
          if (softFail && ok === null) {
            failed += 1;
            failedTasks.push(task);
          } else {
            built += 1;
            const match = task.label.match(/^distribution-(overview|trends)-(\d+)-(reserve|new|old)$/);
            logDiag("precompute-distribution", {
              kind: match?.[1] ?? task.label,
              year: match?.[2] ? Number(match[2]) : null,
              tab: (match?.[3] as DistributionTab | undefined) ?? null,
              ms,
            });
            console.log(`[precompute]   ${task.label} done (${(ms / 1000).toFixed(1)}s)`);
          }
          const pruned = pruneCacheKeyPrefix("distribution-cohort-board-");
          if (pruned > 0) {
            logDiag("precompute-cohort-prune", { keys: pruned });
          }
          if (PRECOMPUTE_DISTRIBUTION_TASK_DELAY_MS > 0) {
            await sleep(PRECOMPUTE_DISTRIBUTION_TASK_DELAY_MS);
          }
        }),
        PRECOMPUTE_DISTRIBUTION_CONCURRENCY,
      );
    };

    await runDistTasks(tasks, true);

    if (failedTasks.length > 0) {
      console.log(
        `[precompute]   distribution retry pass: ${failedTasks.length} task(s) after soft-fail`,
      );
      const retryCount = failedTasks.length;
      failed -= retryCount;
      for (const task of failedTasks) {
        await waitForPrecomputeSlot();
        const t0 = Date.now();
        try {
          await retry(task.run, `${task.label}-retry`);
          built += 1;
          console.log(`[precompute]   ${task.label} retry ok (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
        } catch (err) {
          failed += 1;
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[precompute] SKIP ${task.label} after hard retry: ${message}`);
          logDiagError("precompute-task-skipped", err, { label: task.label, pass: "hard-retry" });
        }
        if (PRECOMPUTE_DISTRIBUTION_TASK_DELAY_MS > 0) {
          await sleep(PRECOMPUTE_DISTRIBUTION_TASK_DELAY_MS);
        }
      }
    }

    const elapsed = ((Date.now() - phaseStart) / 1000).toFixed(1);
    console.log(
      `[precompute] Phase 4 done (${elapsed}s, built=${built}, skipped=${skipped}, failed=${failed})`,
    );
    logDiag("precompute-phase", {
      phase: 4,
      elapsedSec: Math.round((Date.now() - phaseStart) / 1000),
      built,
      skipped,
      failed,
    });
  } finally {
    setForceRefresh(true);
  }
}

export async function precomputeAll(options?: {
  label?: string;
}): Promise<{ durationMs: number; keys: number }> {
  const start = Date.now();
  const label = options?.label;
  setForceRefresh(true);

  try {
    await waitForPrecomputeSlot();
    console.log("[precompute] Phase 1: Dashboard + Rankings...");
    await runBatch([
      { label: "dashboard", fn: () => gameService.getDashboardStats() },
      { label: "dates", fn: () => gameService.getAvailableDates() },
      { label: "tags", fn: () => gameService.getTags() },
      ...ALL_PLATFORMS.flatMap((platform) => [
        {
          label: `rankings-${platform}-reserve`,
          fn: () => gameService.getRankings({ platform, page: "1", limit: "1", segment: "reserve" }),
        },
        {
          label: `rankings-${platform}-launched`,
          fn: () => gameService.getRankings({ platform, page: "1", limit: "1", segment: "launched" }),
        },
      ]),
    ]);
    console.log(`[precompute] Phase 1 done (${((Date.now() - start) / 1000).toFixed(1)}s)`);
    logDiag("precompute-phase", { phase: 1, elapsedSec: Math.round((Date.now() - start) / 1000) });

    await waitForPrecomputeSlot();
    // Load Distribution-calibrated scorers (from disk/cache) before scoring Potential.
    try {
      await refreshPotentialScorers();
      console.log("[precompute]   potential distribution scorers ready");
    } catch (err) {
      console.warn("[precompute]   potential scorers refresh failed (using fallback):", (err as Error).message);
    }
    console.log("[precompute] Phase 2: Potential analysis...");
    for (const platform of ALL_PLATFORMS) {
      await waitForPrecomputeSlot();
      console.log(`[precompute]   platform=${platform}...`);
      await runBatch(
        [
          ...POTENTIAL_DAYS.flatMap((days) => [
            {
              label: `potential-reserve-${platform}-${days}`,
              fn: () => rankingService.calculatePotentialScores(days, platform, "reserve"),
            },
            {
              label: `potential-launched-${platform}-${days}`,
              fn: () => rankingService.calculatePotentialScores(days, platform, "launched"),
            },
          ]),
          ...POTENTIAL_DAYS.flatMap((days) => [
            {
              label: `breakout-reserve-${platform}-${days}`,
              fn: () => rankingService.detectBreakoutGames(days, 10, platform, "reserve"),
            },
            {
              label: `breakout-launched-${platform}-${days}`,
              fn: () => rankingService.detectBreakoutGames(days, 10, platform, "launched"),
            },
          ]),
          ...POTENTIAL_DAYS.map((days) => ({
            label: `reserve-${platform}-${days}`,
            fn: () => rankingService.getTopReserveGrowth(days, platform),
          })),
        ],
      );
    }
    console.log(`[precompute] Phase 2 done (${((Date.now() - start) / 1000).toFixed(1)}s)`);
    logDiag("precompute-phase", { phase: 2, elapsedSec: Math.round((Date.now() - start) / 1000) });

    await waitForPrecomputeSlot();
    const { top: topIds, extra: extraIds } = await collectPrecomputeAppIds();
    console.log(
      `[precompute] Phase 3: top ${topIds.length} + extra (new/latest) ${extraIds.length} games...`,
    );

    const runAppBatches = async (
      ids: number[],
      daysList: number[],
      batchLabel: string,
    ) => {
      if (ids.length === 0) return;
      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        await waitForPrecomputeSlot();
        const batch = ids.slice(i, i + BATCH_SIZE);
        const progress = `${batchLabel} [${i + 1}-${Math.min(i + BATCH_SIZE, ids.length)}/${ids.length}]`;
        await runBatch(batch.flatMap((appId) => detailTasksForApp(appId, daysList)));
        const elapsed = ((Date.now() - start) / 1000).toFixed(0);
        console.log(`[precompute] ${progress} done (${elapsed}s elapsed)`);
        logDiag("precompute-batch", {
          phase: 3,
          batchLabel,
          progress,
          elapsedSec: Number(elapsed),
        });
        if (i + BATCH_SIZE < ids.length) await sleep(BATCH_DELAY_MS);
      }
    };

    await runAppBatches(topIds, DETAIL_DAYS, "top");
    await runAppBatches(extraIds, [7, 14], "extra");
    console.log(`[precompute] Phase 3 done (${((Date.now() - start) / 1000).toFixed(1)}s)`);
    logDiag("precompute-phase", { phase: 3, elapsedSec: Math.round((Date.now() - start) / 1000) });

    // Distribution last: heaviest RAM + DB; soft-fail so deploy never dies here.
    await precomputeDistribution({ force: shouldForceDistributionRefresh(label), label });

    // Refresh Potential scorers from freshly computed distributions for on-demand scoring.
    try {
      await refreshPotentialScorers();
    } catch (err) {
      console.warn("[precompute]   potential scorers post-refresh failed:", (err as Error).message);
    }

    const duration = Date.now() - start;
    console.log(`[precompute] All done in ${(duration / 1000).toFixed(1)}s (${cache.keys().length} keys cached)`);
    logDiag("precompute-phase", {
      phase: "done",
      durationSec: Math.round(duration / 1000),
      cacheKeys: cache.keys().length,
    });

    return { durationMs: duration, keys: cache.keys().length };
  } finally {
    setForceRefresh(false);
  }
}
