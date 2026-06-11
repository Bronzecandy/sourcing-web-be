import { cache, cacheHas, setForceRefresh } from "./utils/cache";
import { waitForPrecomputeSlot } from "./utils/analysis-active-guard";
import { withDbRetry } from "./utils/db-retry";
import { logDiag } from "./utils/process-diagnostics";
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
import type { DistributionTab } from "./types";
import { prisma } from "./utils/prisma";

const ALL_PLATFORMS = ["combined", "android", "ios"] as const;
const POTENTIAL_DAYS = [7, 14, 30];
const DETAIL_DAYS = [7, 14, 30, 60];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function retry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  return withDbRetry(fn, label);
}

async function runSequential(tasks: Array<{ label: string; fn: () => Promise<unknown> }>) {
  for (const t of tasks) {
    await waitForPrecomputeSlot();
    await retry(t.fn, t.label);
  }
}

const PRECOMPUTE_DB_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.PRECOMPUTE_DB_CONCURRENCY ?? "8", 10) || 8,
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

/** Game mới lên BXH (lần đầu xuất hiện trong N ngày gần đây). */
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

/** Mọi game có mặt trên snapshot BXH mới nhất (bắt game vừa vào top). */
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
  parseInt(process.env.PRECOMPUTE_DISTRIBUTION_CONCURRENCY ?? "2", 10) || 2,
);

function isDistributionPrecomputeEnabled(): boolean {
  return process.env.PRECOMPUTE_DISTRIBUTION !== "0";
}

function shouldForceDistributionRefresh(label?: string): boolean {
  if (process.env.PRECOMPUTE_DISTRIBUTION_FORCE === "1") return true;
  if (process.env.PRECOMPUTE_DISTRIBUTION_FORCE === "0") return false;
  return label === "cron" || label === "admin-refresh";
}

async function precomputeDistribution(options: { force: boolean }): Promise<void> {
  if (!isDistributionPrecomputeEnabled()) {
    console.log("[precompute] Phase 4: Distribution skipped (PRECOMPUTE_DISTRIBUTION=0)");
    return;
  }

  const includeTrends = process.env.PRECOMPUTE_DISTRIBUTION_INCLUDE_TRENDS !== "0";
  const phaseStart = Date.now();
  console.log("[precompute] Phase 4: Distribution analytics...");

  setForceRefresh(false);
  try {
    await waitForPrecomputeSlot();
    const meta = await distributionService.getMeta();
    const years = meta.years;

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

    let skipped = 0;
    await runWithConcurrency(
      tasks.map((task) => async () => {
        if (!options.force && cacheHas(task.cacheKey)) {
          skipped += 1;
          return;
        }
        await waitForPrecomputeSlot();
        const t0 = Date.now();
        await retry(task.run, task.label);
        const ms = Date.now() - t0;
        const match = task.label.match(/^distribution-(overview|trends)-(\d+)-(reserve|new|old)$/);
        logDiag("precompute-distribution", {
          kind: match?.[1] ?? task.label,
          year: match?.[2] ? Number(match[2]) : null,
          tab: (match?.[3] as DistributionTab | undefined) ?? null,
          ms,
        });
        console.log(`[precompute]   ${task.label} done (${(ms / 1000).toFixed(1)}s)`);
      }),
      PRECOMPUTE_DISTRIBUTION_CONCURRENCY,
    );

    const elapsed = ((Date.now() - phaseStart) / 1000).toFixed(1);
    console.log(
      `[precompute] Phase 4 done (${elapsed}s, ${tasks.length - skipped} built, ${skipped} skipped)`,
    );
    logDiag("precompute-phase", {
      phase: 4,
      elapsedSec: Math.round((Date.now() - phaseStart) / 1000),
      built: tasks.length - skipped,
      skipped,
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
    // Phase 1: Dashboard + dates + tags + rankings — all in parallel
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

    await precomputeDistribution({ force: shouldForceDistributionRefresh(label) });

    // Phase 2: Potential analysis — per platform sequentially, queries within a platform in parallel
    await waitForPrecomputeSlot();
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
        ]
      );
    }
    console.log(`[precompute] Phase 2 done (${((Date.now() - start) / 1000).toFixed(1)}s)`);
    logDiag("precompute-phase", { phase: 2, elapsedSec: Math.round((Date.now() - start) / 1000) });

    // Phase 3: Top 200 — full detail + potential + breakdown
    await waitForPrecomputeSlot();
    const { top: topIds, extra: extraIds } = await collectPrecomputeAppIds();
    console.log(
      `[precompute] Phase 3: top ${topIds.length} + extra (new/latest) ${extraIds.length} games...`,
    );

    const runAppBatches = async (
      ids: number[],
      daysList: number[],
      label: string,
    ) => {
      if (ids.length === 0) return;
      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        await waitForPrecomputeSlot();
        const batch = ids.slice(i, i + BATCH_SIZE);
        const progress = `${label} [${i + 1}-${Math.min(i + BATCH_SIZE, ids.length)}/${ids.length}]`;
        await runBatch(batch.flatMap((appId) => detailTasksForApp(appId, daysList)));
        const elapsed = ((Date.now() - start) / 1000).toFixed(0);
        console.log(`[precompute] ${progress} done (${elapsed}s elapsed)`);
        logDiag("precompute-batch", {
          phase: 3,
          batchLabel: label,
          progress,
          elapsedSec: Number(elapsed),
        });
        if (i + BATCH_SIZE < ids.length) await sleep(BATCH_DELAY_MS);
      }
    };

    await runAppBatches(topIds, DETAIL_DAYS, "top");
    // Game mới / snapshot mới nhất: chỉ warm 7+14 ngày (tiết kiệm thời gian & cache)
    await runAppBatches(extraIds, [7, 14], "extra");

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
