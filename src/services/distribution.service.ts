import { pool } from "../utils/prisma";
import { getCachedOrFetch } from "../utils/cache";
import { withDbRetry } from "../utils/db-retry";
import { runWithConcurrency } from "../utils/run-with-concurrency";
import {
  hasLaunchedRank,
  hasReserveRank,
  type AppRankRow,
} from "../utils/app-rank";

const RESERVE_BOARD_SQL = `("reserveAndroidRank" IS NOT NULL OR "reserveIosRank" IS NOT NULL)`;
const LAUNCHED_BOARD_SQL = `(
  "hotAndroidRank" IS NOT NULL OR "hotIosRank" IS NOT NULL OR
  "popAndroidRank" IS NOT NULL OR "popIosRank" IS NOT NULL OR
  "newAndroidRank" IS NOT NULL OR "newIosRank" IS NOT NULL
)`;
import {
  downloadCountFromRaw,
  fansCountFromRaw,
  releaseDateFromRaw,
} from "../utils/taptap-raw-extract";
import type {
  DistributionBucket,
  DistributionLifecycle,
  DistributionMetric,
  DistributionQuery,
  DistributionResponse,
  DistributionMeta,
  DistributionMonthlyPoint,
  DistributionSummary,
  BucketDefinition,
  DistributionTab,
  DistributionOverviewQuery,
  DistributionOverviewResponse,
  DistributionTrendsResponse,
  DistributionMetricBlock,
  DistributionTrendPoint,
  DistributionGrowthBucket,
  DistributionRatingInsights,
  DistributionTabInsights,
} from "../types";

export const METRICS_BY_TAB: Record<DistributionTab, DistributionMetric[]> = {
  reserve: ["reserve", "rating", "fans"],
  new: ["download", "fans", "rating", "reviewCount"],
  old: ["download", "fans", "rating", "reviewCount"],
};

export const DISTRIBUTION_TABS: DistributionTab[] = ["reserve", "new", "old"];

export const DISTRIBUTION_META_CACHE_KEY = "distribution-meta-v2";

export function distributionOverviewCacheKey(
  year: number | null,
  lifecycle: DistributionTab,
  month?: number | null,
): string {
  return `distribution-overview-v7-${year ?? "all"}-${month ?? "full"}-${lifecycle}`;
}

export function distributionTrendsCacheKey(
  year: number | null,
  lifecycle: DistributionTab,
  month?: number | null,
): string {
  return `distribution-trends-v1-${year ?? "all"}-${month ?? "full"}-${lifecycle}`;
}

const CACHE_TTL = 86400;
const HEAVY_DB_RETRY = { maxAttempts: 12, delayMs: 2000 };
const TRENDS_MONTH_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.DISTRIBUTION_TRENDS_MONTH_CONCURRENCY ?? "4", 10) || 4,
);

const COHORT_ROW_SELECT = `
    "appId",
    "date",
    "reserveAndroidRank",
    "reserveIosRank",
    "hotAndroidRank",
    "hotIosRank",
    "popAndroidRank",
    "popIosRank",
    "newAndroidRank",
    "newIosRank",
    (raw->'stat'->>'fans_count')::int AS "fansCount",
    (raw->'stat'->>'reserve_count')::int AS "reserveCount",
    COALESCE(
      NULLIF((raw->'stat'->>'hits_total')::bigint, 0),
      NULLIF((raw->'stat'->>'download_count')::bigint, 0),
      NULLIF((raw->'stat'->>'pc_download_count')::bigint, 0),
      NULLIF((raw->'stat'->>'play_total')::bigint, 0)
    ) AS "downloadCount",
    raw->'stat'->'rating'->>'score' AS rating,
    (raw->'stat'->>'review_count')::int AS "reviewCount",
    raw`;

const COUNT_BUCKETS: BucketDefinition[] = [
  { label: "0", min: 0, max: 0 },
  { label: "1–10K", min: 1, max: 10_000 },
  { label: "10K–50K", min: 10_001, max: 50_000 },
  { label: "50K–100K", min: 50_001, max: 100_000 },
  { label: "100K–500K", min: 100_001, max: 500_000 },
  { label: "500K–1M", min: 500_001, max: 1_000_000 },
  { label: "1M+", min: 1_000_001, max: null },
];

const RATING_BUCKETS: BucketDefinition[] = [
  { label: "<5", min: 0, max: 4.99 },
  { label: "5–6", min: 5, max: 5.99 },
  { label: "6–7", min: 6, max: 6.99 },
  { label: "7–8", min: 7, max: 7.99 },
  { label: "8–9", min: 8, max: 8.99 },
  { label: "9–10", min: 9, max: 10 },
];

const REVIEW_BUCKETS: BucketDefinition[] = [
  { label: "0", min: 0, max: 0 },
  { label: "1–100", min: 1, max: 100 },
  { label: "100–1K", min: 101, max: 1_000 },
  { label: "1K–10K", min: 1_001, max: 10_000 },
  { label: "10K–50K", min: 10_001, max: 50_000 },
  { label: "50K+", min: 50_001, max: null },
];

const COUNT_GROWTH_BUCKETS: BucketDefinition[] = [
  { label: "≤ -100K", min: -9_000_000_000, max: -100_000 },
  { label: "-100K ~ -50K", min: -100_000, max: -50_001 },
  { label: "-50K ~ -20K", min: -50_000, max: -20_001 },
  { label: "-20K ~ -10K", min: -20_000, max: -10_001 },
  { label: "-10K ~ -5K", min: -10_000, max: -5_001 },
  { label: "-5K ~ 0", min: -5_000, max: -1 },
  { label: "Không đổi", min: 0, max: 0 },
  { label: "+1 ~ +5K", min: 1, max: 5_000 },
  { label: "+5K ~ +10K", min: 5_001, max: 10_000 },
  { label: "+10K ~ +20K", min: 10_001, max: 20_000 },
  { label: "+20K ~ +50K", min: 20_001, max: 50_000 },
  { label: "+50K ~ +100K", min: 50_001, max: 100_000 },
  { label: "+100K+", min: 100_001, max: null },
];

const RATING_GROWTH_BUCKETS: BucketDefinition[] = [
  { label: "Giảm ≥ 0.5", min: -10, max: -0.5 },
  { label: "-0.5 ~ -0.2", min: -0.499, max: -0.2 },
  { label: "-0.2 ~ 0", min: -0.199, max: -0.001 },
  { label: "Không đổi", min: 0, max: 0 },
  { label: "+0.01 ~ +0.2", min: 0.001, max: 0.2 },
  { label: "+0.2 ~ +0.5", min: 0.201, max: 0.499 },
  { label: "Tăng ≥ 0.5", min: 0.5, max: 10 },
];

const METRIC_LABELS: Record<DistributionMetric, string> = {
  reserve: "Đăng ký trước",
  download: "Download",
  rating: "Rating",
  reviewCount: "Bình luận",
  fans: "Fans",
};

const DISTRIBUTION_SNAPSHOT_SQL = `
  SELECT
    "appId",
    "date",
    "reserveAndroidRank",
    "reserveIosRank",
    "hotAndroidRank",
    "hotIosRank",
    "popAndroidRank",
    "popIosRank",
    "newAndroidRank",
    "newIosRank",
    (raw->'stat'->>'fans_count')::int AS "fansCount",
    (raw->'stat'->>'reserve_count')::int AS "reserveCount",
    COALESCE(
      NULLIF((raw->'stat'->>'hits_total')::bigint, 0),
      NULLIF((raw->'stat'->>'download_count')::bigint, 0),
      NULLIF((raw->'stat'->>'pc_download_count')::bigint, 0),
      NULLIF((raw->'stat'->>'play_total')::bigint, 0)
    ) AS "downloadCount",
    raw->'stat'->'rating'->>'score' AS rating,
    (raw->'stat'->>'review_count')::int AS "reviewCount",
    raw
  FROM "AppRank"
  WHERE "date" = $1
`;

interface AppSnapshot {
  appId: number;
  row: AppRankRow;
  value: number;
  lifecycle: DistributionLifecycle;
}

function bucketsForMetric(metric: DistributionMetric): BucketDefinition[] {
  if (metric === "rating") return RATING_BUCKETS;
  if (metric === "reviewCount") return REVIEW_BUCKETS;
  return COUNT_BUCKETS;
}

function growthBucketsForMetric(metric: DistributionMetric): BucketDefinition[] {
  if (metric === "rating") return RATING_GROWTH_BUCKETS;
  return COUNT_GROWTH_BUCKETS;
}

function monthsBetween(from: Date, to: Date): number {
  let months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  if (to.getDate() < from.getDate()) months--;
  return months;
}

function classifyLifecycle(row: AppRankRow, asOf: Date): DistributionLifecycle {
  if (hasReserveRank(row) && !hasLaunchedRank(row)) return "reserve";
  const releaseDate = releaseDateFromRaw(row.raw);
  if (!releaseDate) return "unknown";
  if (monthsBetween(releaseDate, asOf) < 6) return "new";
  return "old";
}

/** Phân loại game đã lên bảng Hot/Pop/New theo tuổi ra mắt tại thời điểm snapshot. */
function classifyLaunchedTab(row: AppRankRow): DistributionTab | "unknown" {
  const releaseDate = releaseDateFromRaw(row.raw);
  if (!releaseDate) return "unknown";
  if (monthsBetween(releaseDate, row.date) < 6) return "new";
  return "old";
}

function isBoardTab(lifecycle: DistributionQuery["lifecycle"]): lifecycle is DistributionTab {
  return lifecycle === "reserve" || lifecycle === "new" || lifecycle === "old";
}

function metricValue(row: AppRankRow, metric: DistributionMetric): number | null {
  switch (metric) {
    case "reserve":
      return row.reserveCount ?? null;
    case "download": {
      const n = row.downloadCount ?? downloadCountFromRaw(row.raw);
      return n != null && n > 0 ? n : null;
    }
    case "fans": {
      const n = row.fansCount ?? fansCountFromRaw(row.raw);
      return n != null ? n : null;
    }
    case "rating": {
      const s = row.rating;
      if (!s) return null;
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    }
    case "reviewCount":
      return row.reviewCount ?? null;
    default:
      return null;
  }
}

function findBucket(value: number, defs: BucketDefinition[]): BucketDefinition {
  for (const b of defs) {
    if (b.max == null) {
      if (value >= b.min) return b;
    } else if (value >= b.min && value <= b.max) {
      return b;
    }
  }
  return defs[defs.length - 1]!;
}

function rowToAppRankRow(r: Record<string, unknown>): AppRankRow {
  return {
    appId: r.appId as number,
    date: r.date as Date,
    reserveAndroidRank: r.reserveAndroidRank as number | null,
    reserveIosRank: r.reserveIosRank as number | null,
    hotAndroidRank: r.hotAndroidRank as number | null,
    hotIosRank: r.hotIosRank as number | null,
    popAndroidRank: r.popAndroidRank as number | null,
    popIosRank: r.popIosRank as number | null,
    newAndroidRank: r.newAndroidRank as number | null,
    newIosRank: r.newIosRank as number | null,
    fansCount: r.fansCount as number | null,
    reserveCount: r.reserveCount as number | null,
    downloadCount: r.downloadCount as number | null,
    rating: r.rating as string | null,
    reviewCount: r.reviewCount as number | null,
    raw: r.raw,
  };
}

type SnapshotCache = Map<string, Map<number, AppRankRow>>;

function dateKey(date: Date): string {
  return date.toISOString().split("T")[0]!;
}

async function fetchSnapshot(date: Date, cache?: SnapshotCache): Promise<Map<number, AppRankRow>> {
  const key = dateKey(date);
  if (cache?.has(key)) return cache.get(key)!;

  const { rows } = await pool.query(DISTRIBUTION_SNAPSHOT_SQL, [date]);
  const map = new Map<number, AppRankRow>();
  for (const r of rows as Record<string, unknown>[]) {
    const row = rowToAppRankRow(r);
    map.set(row.appId, row);
  }
  cache?.set(key, map);
  return map;
}

async function resolvePeriodBounds(
  year: number | null,
  month?: number,
): Promise<{ periodStart: Date | null; periodEnd: Date | null }> {
  if (year == null) {
    if (month != null) {
      const { rows } = await pool.query<{ start: Date | null; end: Date | null }>(
        `SELECT MIN("date") AS start, MAX("date") AS end
         FROM "AppRank"
         WHERE EXTRACT(MONTH FROM "date") = $1`,
        [month],
      );
      return { periodStart: rows[0]?.start ?? null, periodEnd: rows[0]?.end ?? null };
    }
    const { rows } = await pool.query<{ start: Date | null; end: Date | null }>(
      `SELECT MIN("date") AS start, MAX("date") AS end FROM "AppRank"`,
    );
    return { periodStart: rows[0]?.start ?? null, periodEnd: rows[0]?.end ?? null };
  }
  if (month != null) {
    const { rows } = await pool.query<{ start: Date | null; end: Date | null }>(
      `SELECT MIN("date") AS start, MAX("date") AS end
       FROM "AppRank"
       WHERE EXTRACT(YEAR FROM "date") = $1 AND EXTRACT(MONTH FROM "date") = $2`,
      [year, month],
    );
    return { periodStart: rows[0]?.start ?? null, periodEnd: rows[0]?.end ?? null };
  }
  const { rows } = await pool.query<{ start: Date | null; end: Date | null }>(
    `SELECT MIN("date") AS start, MAX("date") AS end
     FROM "AppRank"
     WHERE EXTRACT(YEAR FROM "date") = $1`,
    [year],
  );
  return { periodStart: rows[0]?.start ?? null, periodEnd: rows[0]?.end ?? null };
}

async function resolveMonthlyBoundsForYear(
  year: number,
): Promise<Map<number, { periodStart: Date; periodEnd: Date }>> {
  const { rows } = await pool.query<{ month: number; start: Date | null; end: Date | null }>(
    `SELECT EXTRACT(MONTH FROM "date")::int AS month,
            MIN("date") AS start, MAX("date") AS end
     FROM "AppRank"
     WHERE EXTRACT(YEAR FROM "date") = $1
     GROUP BY 1
     ORDER BY 1`,
    [year],
  );
  const out = new Map<number, { periodStart: Date; periodEnd: Date }>();
  for (const r of rows) {
    if (r.start && r.end) out.set(r.month, { periodStart: r.start, periodEnd: r.end });
  }
  return out;
}

type CohortEdgeRows = { firstByApp: Map<number, AppRankRow>; lastByApp: Map<number, AppRankRow> };

function cohortBoardCacheKey(
  board: "reserve" | "launched",
  periodStart: Date,
  periodEnd: Date,
): string {
  const start = periodStart.toISOString().split("T")[0];
  const end = periodEnd.toISOString().split("T")[0];
  return `distribution-cohort-board-${board}-${start}-${end}`;
}

async function fetchBoardCohortEdgesRaw(
  periodStart: Date,
  periodEnd: Date,
  board: "reserve" | "launched",
): Promise<CohortEdgeRows> {
  const boardFilter = board === "reserve" ? RESERVE_BOARD_SQL : LAUNCHED_BOARD_SQL;
  const where = `"date" >= $1::date AND "date" <= $2::date AND ${boardFilter}`;
  const params = [periodStart, periodEnd];
  const label = `distribution-cohort-${board}`;

  const { rows: firstRows } = await withDbRetry(
    () =>
      pool.query(
        `SELECT DISTINCT ON ("appId") ${COHORT_ROW_SELECT}
         FROM "AppRank"
         WHERE ${where}
         ORDER BY "appId", "date" ASC`,
        params,
      ),
    `${label}-first`,
    HEAVY_DB_RETRY,
  );

  const { rows: lastRows } = await withDbRetry(
    () =>
      pool.query(
        `SELECT DISTINCT ON ("appId") ${COHORT_ROW_SELECT}
         FROM "AppRank"
         WHERE ${where}
         ORDER BY "appId", "date" DESC`,
        params,
      ),
    `${label}-last`,
    HEAVY_DB_RETRY,
  );

  const firstByApp = new Map<number, AppRankRow>();
  const lastByApp = new Map<number, AppRankRow>();
  for (const r of firstRows as Record<string, unknown>[]) {
    const row = rowToAppRankRow(r);
    firstByApp.set(row.appId, row);
  }
  for (const r of lastRows as Record<string, unknown>[]) {
    const row = rowToAppRankRow(r);
    lastByApp.set(row.appId, row);
  }

  return { firstByApp, lastByApp };
}

async function fetchBoardCohortEdgesCached(
  periodStart: Date,
  periodEnd: Date,
  board: "reserve" | "launched",
): Promise<CohortEdgeRows> {
  const key = cohortBoardCacheKey(board, periodStart, periodEnd);
  return getCachedOrFetch(
    key,
    () => fetchBoardCohortEdgesRaw(periodStart, periodEnd, board),
    CACHE_TTL,
    HEAVY_DB_RETRY,
  );
}

function filterTabCohortEdges(launched: CohortEdgeRows, tab: DistributionTab): CohortEdgeRows {
  const filteredFirst = new Map<number, AppRankRow>();
  const filteredLast = new Map<number, AppRankRow>();
  for (const [appId, lastRow] of launched.lastByApp) {
    if (classifyLaunchedTab(lastRow) !== tab) continue;
    filteredLast.set(appId, lastRow);
    const firstRow = launched.firstByApp.get(appId);
    if (firstRow) filteredFirst.set(appId, firstRow);
  }
  return { firstByApp: filteredFirst, lastByApp: filteredLast };
}

async function fetchTabCohortEdges(
  periodStart: Date,
  periodEnd: Date,
  tab: DistributionTab,
): Promise<CohortEdgeRows> {
  if (tab === "reserve") {
    return fetchBoardCohortEdgesCached(periodStart, periodEnd, "reserve");
  }
  const launched = await fetchBoardCohortEdgesCached(periodStart, periodEnd, "launched");
  return filterTabCohortEdges(launched, tab);
}

async function fetchReserveDistinctCount(periodStart: Date, periodEnd: Date): Promise<number> {
  return parseInt(
    (
      await withDbRetry(
        () =>
          pool.query<{ count: string }>(
            `SELECT COUNT(DISTINCT "appId")::text AS count
             FROM "AppRank"
             WHERE "date" >= $1::date AND "date" <= $2::date
               AND ${RESERVE_BOARD_SQL}`,
            [periodStart, periodEnd],
          ),
        "distribution-segment-reserve-count",
        HEAVY_DB_RETRY,
      )
    ).rows[0]?.count ?? "0",
    10,
  );
}

function segmentCountsFromLaunchedLast(
  launchedLastByApp: Map<number, AppRankRow>,
  reserveCount: number,
): Record<DistributionLifecycle, number> {
  const counts = emptyLifecycleCounts();
  counts.reserve = reserveCount;
  for (const row of launchedLastByApp.values()) {
    const launchedTab = classifyLaunchedTab(row);
    if (launchedTab === "new") counts.new += 1;
    else if (launchedTab === "old") counts.old += 1;
    else counts.unknown += 1;
  }
  return counts;
}

function emptyMetricBuckets(metric: DistributionMetric): DistributionBucket[] {
  return bucketsForMetric(metric).map((b) => ({
    label: b.label,
    min: b.min,
    max: b.max,
    count: 0,
    countDelta: 0,
    metricSum: 0,
    metricDelta: 0,
    byLifecycle: emptyLifecycleCounts(),
  }));
}

function emptyGrowthBuckets(metric: DistributionMetric): DistributionGrowthBucket[] {
  return growthBucketsForMetric(metric).map((b) => ({
    label: b.label,
    min: b.min,
    max: b.max,
    count: 0,
    totalDelta: 0,
    sharePct: 0,
  }));
}

interface PeriodComputeResult {
  absoluteBuckets: DistributionBucket[];
  growthBuckets: DistributionGrowthBucket[];
  summary: DistributionSummary;
  gamesIncreased: number;
  gamesDecreased: number;
  gamesFlat: number;
  ratingInsights?: DistributionRatingInsights;
}

function metricBlockFromResult(
  metric: DistributionMetric,
  result: PeriodComputeResult,
  trend: DistributionTrendPoint[],
): DistributionMetricBlock {
  const absoluteBuckets = result.absoluteBuckets;
  return {
    metric,
    label: METRIC_LABELS[metric],
    buckets: absoluteBuckets,
    absoluteBuckets,
    growthBuckets: result.growthBuckets,
    totalGames: result.summary.totalGames,
    metricSum: absoluteBuckets.reduce((s, b) => s + b.metricSum, 0),
    metricDelta: absoluteBuckets.reduce((s, b) => s + b.metricDelta, 0),
    gamesWithGrowth: result.summary.totalGames,
    gamesIncreased: result.gamesIncreased,
    gamesDecreased: result.gamesDecreased,
    gamesFlat: result.gamesFlat,
    trend,
    ratingInsights: result.ratingInsights,
  };
}

function emptyLifecycleCounts(): DistributionBucket["byLifecycle"] {
  return { reserve: 0, new: 0, old: 0, unknown: 0 };
}

function buildCohortSnapshots(
  firstByApp: Map<number, AppRankRow>,
  lastByApp: Map<number, AppRankRow>,
  metric: DistributionMetric,
  tab: DistributionTab,
): { endApps: AppSnapshot[]; startByApp: Map<number, AppSnapshot> } {
  const lifecycle: DistributionLifecycle = tab;
  const startByApp = new Map<number, AppSnapshot>();
  const endApps: AppSnapshot[] = [];

  for (const [appId, row] of firstByApp) {
    const value = metricValue(row, metric);
    if (value == null) continue;
    startByApp.set(appId, { appId, row, value, lifecycle });
  }

  for (const [appId, row] of lastByApp) {
    const value = metricValue(row, metric);
    if (value == null) continue;
    endApps.push({ appId, row, value, lifecycle });
  }

  return { endApps, startByApp };
}

function buildSnapshots(
  endMap: Map<number, AppRankRow>,
  startMap: Map<number, AppRankRow>,
  metric: DistributionMetric,
  lifecycleFilter: DistributionQuery["lifecycle"],
  asOf: Date,
): { endApps: AppSnapshot[]; startByApp: Map<number, AppSnapshot> } {
  const endApps: AppSnapshot[] = [];
  const startByApp = new Map<number, AppSnapshot>();

  for (const [appId, row] of startMap) {
    const value = metricValue(row, metric);
    if (value == null) continue;
    const lc = classifyLifecycle(row, asOf);
    if (lifecycleFilter !== "all" && lc !== lifecycleFilter) continue;
    startByApp.set(appId, {
      appId,
      row,
      value,
      lifecycle: lc,
    });
  }

  for (const [appId, row] of endMap) {
    const value = metricValue(row, metric);
    if (value == null) continue;
    const lifecycle = classifyLifecycle(row, asOf);
    if (lifecycleFilter !== "all" && lifecycle !== lifecycleFilter) continue;
    endApps.push({ appId, row, value, lifecycle });
  }

  return { endApps, startByApp };
}

function aggregateBuckets(
  endApps: AppSnapshot[],
  startByApp: Map<number, AppSnapshot>,
  metric: DistributionMetric,
): DistributionBucket[] {
  const defs = bucketsForMetric(metric);
  const endCounts = new Map<string, number>();
  const startCounts = new Map<string, number>();
  const byLifecycle = new Map<string, DistributionBucket["byLifecycle"]>();
  const metricSums = new Map<string, number>();
  const metricDeltas = new Map<string, number>();

  for (const b of defs) {
    endCounts.set(b.label, 0);
    startCounts.set(b.label, 0);
    byLifecycle.set(b.label, emptyLifecycleCounts());
    metricSums.set(b.label, 0);
    metricDeltas.set(b.label, 0);
  }

  for (const app of endApps) {
    const bucket = findBucket(app.value, defs);
    endCounts.set(bucket.label, (endCounts.get(bucket.label) ?? 0) + 1);
    metricSums.set(bucket.label, (metricSums.get(bucket.label) ?? 0) + app.value);
    const lc = byLifecycle.get(bucket.label)!;
    lc[app.lifecycle] += 1;

    const startApp = startByApp.get(app.appId);
    const delta = startApp ? app.value - startApp.value : 0;
    metricDeltas.set(bucket.label, (metricDeltas.get(bucket.label) ?? 0) + delta);
  }

  for (const [, app] of startByApp) {
    const bucket = findBucket(app.value, defs);
    startCounts.set(bucket.label, (startCounts.get(bucket.label) ?? 0) + 1);
  }

  return defs.map((b) => ({
    label: b.label,
    min: b.min,
    max: b.max,
    count: endCounts.get(b.label) ?? 0,
    countDelta: (endCounts.get(b.label) ?? 0) - (startCounts.get(b.label) ?? 0),
    metricSum: metricSums.get(b.label) ?? 0,
    metricDelta: metricDeltas.get(b.label) ?? 0,
    byLifecycle: byLifecycle.get(b.label) ?? emptyLifecycleCounts(),
  }));
}

function aggregateGrowthBuckets(
  endApps: AppSnapshot[],
  startByApp: Map<number, AppSnapshot>,
  metric: DistributionMetric,
): { buckets: DistributionGrowthBucket[]; increased: number; decreased: number; flat: number } {
  const defs = growthBucketsForMetric(metric);
  const counts = new Map<string, number>();
  const totalDeltas = new Map<string, number>();
  for (const b of defs) {
    counts.set(b.label, 0);
    totalDeltas.set(b.label, 0);
  }

  let increased = 0;
  let decreased = 0;
  let flat = 0;

  for (const app of endApps) {
    const startApp = startByApp.get(app.appId);
    const delta = startApp ? app.value - startApp.value : 0;
    if (delta > 0) increased++;
    else if (delta < 0) decreased++;
    else flat++;

    const bucket = findBucket(delta, defs);
    counts.set(bucket.label, (counts.get(bucket.label) ?? 0) + 1);
    totalDeltas.set(bucket.label, (totalDeltas.get(bucket.label) ?? 0) + delta);
  }

  const total = endApps.length || 1;
  const buckets = defs.map((b) => ({
    label: b.label,
    min: b.min,
    max: b.max,
    count: counts.get(b.label) ?? 0,
    totalDelta: totalDeltas.get(b.label) ?? 0,
    sharePct: Math.round(((counts.get(b.label) ?? 0) / total) * 1000) / 10,
  }));

  return { buckets, increased, decreased, flat };
}

function vote5StarShareFromRaw(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const app =
    o.app && typeof o.app === "object" ? (o.app as Record<string, unknown>) : o;
  const stat = app.stat;
  if (!stat || typeof stat !== "object") return null;
  const voteInfo = (stat as Record<string, unknown>).vote_info;
  if (!voteInfo || typeof voteInfo !== "object") return null;
  const votes = voteInfo as Record<string, number>;
  let total = 0;
  for (const v of Object.values(votes)) {
    if (typeof v === "number" && Number.isFinite(v)) total += v;
  }
  if (total <= 0) return null;
  const five = votes["5"] ?? 0;
  return Math.round((five / total) * 1000) / 10;
}

function computeRatingInsights(
  endApps: AppSnapshot[],
  startByApp: Map<number, AppSnapshot>,
): DistributionRatingInsights | undefined {
  if (endApps.length === 0) return undefined;

  let high = 0;
  let low = 0;
  let improving = 0;
  let declining = 0;
  let sumRating = 0;
  let sumDelta = 0;
  let vote5Sum = 0;
  let vote5Count = 0;

  for (const app of endApps) {
    sumRating += app.value;
    if (app.value >= 8) high++;
    if (app.value < 6) low++;
    const startApp = startByApp.get(app.appId);
    const delta = startApp ? app.value - startApp.value : 0;
    sumDelta += delta;
    if (delta > 0) improving++;
    else if (delta < 0) declining++;
    const v5 = vote5StarShareFromRaw(app.row.raw);
    if (v5 != null) {
      vote5Sum += v5;
      vote5Count++;
    }
  }

  const n = endApps.length;
  return {
    highRatingShare: Math.round((high / n) * 1000) / 10,
    lowRatingShare: Math.round((low / n) * 1000) / 10,
    improvingShare: Math.round((improving / n) * 1000) / 10,
    decliningShare: Math.round((declining / n) * 1000) / 10,
    avgRating: Math.round((sumRating / n) * 100) / 100,
    avgRatingDelta: Math.round((sumDelta / n) * 1000) / 1000,
    vote5StarShare: vote5Count > 0 ? Math.round((vote5Sum / vote5Count) * 10) / 10 : null,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[mid - 1]! + sorted[mid]!) / 2) * 10) / 10
    : sorted[mid]!;
}

function pct(count: number, total: number): string {
  if (total <= 0) return "0%";
  return `${Math.round((count / total) * 1000) / 10}%`;
}

function computeTabInsights(
  lifecycle: DistributionTab,
  blocks: DistributionMetricBlock[],
): DistributionTabInsights {
  const find = (m: DistributionMetric) => blocks.find((b) => b.metric === m);

  if (lifecycle === "reserve") {
    const reserve = find("reserve");
    const rating = find("rating");
    const endValues: number[] = [];
    if (reserve) {
      for (const b of reserve.absoluteBuckets) {
        const mid = b.max != null ? (b.min + b.max) / 2 : b.min;
        for (let i = 0; i < b.count; i++) endValues.push(mid);
      }
    }
    const total = reserve?.totalGames ?? 0;
    const over100k =
      reserve?.absoluteBuckets
        .filter((b) => b.min >= 100_001 || b.label.includes("100K"))
        .reduce((s, b) => s + b.count, 0) ?? 0;
    const growthOver10k =
      reserve?.growthBuckets
        .filter((b) => b.min >= 10_001)
        .reduce((s, b) => s + b.count, 0) ?? 0;

    return {
      primaryMetric: "reserve",
      label: "Đăng ký trước",
      value: pct(growthOver10k, total),
      sub: "game tăng >10K trong kỳ",
      items: [
        { label: "Tăng >10K", value: pct(growthOver10k, total) },
        { label: "Trên 100K (cuối kỳ)", value: pct(over100k, total) },
        {
          label: "Rating ≥8",
          value: rating?.ratingInsights
            ? `${rating.ratingInsights.highRatingShare}%`
            : "—",
        },
        { label: "Median reserve", value: formatInsightNum(median(endValues)) },
      ],
    };
  }

  if (lifecycle === "new") {
    const download = find("download");
    const fans = find("fans");
    const rating = find("rating");
    const total = download?.totalGames ?? 0;
    const growthOver20k =
      download?.growthBuckets
        .filter((b) => b.min >= 20_001)
        .reduce((s, b) => s + b.count, 0) ?? 0;
    const absOver100k =
      download?.absoluteBuckets
        .filter((b) => b.min >= 100_001)
        .reduce((s, b) => s + b.count, 0) ?? 0;

    return {
      primaryMetric: "download",
      label: "Game mới",
      value: pct(growthOver20k, total),
      sub: "game tăng download >20K",
      items: [
        { label: "Tăng DL >20K", value: pct(growthOver20k, total) },
        { label: "DL >100K", value: pct(absOver100k, total) },
        {
          label: "Fans >50K",
          value: pct(
            fans?.absoluteBuckets
              .filter((b) => b.min >= 50_001)
              .reduce((s, b) => s + b.count, 0) ?? 0,
            fans?.totalGames ?? 0,
          ),
        },
        {
          label: "Rating ≥8",
          value: rating?.ratingInsights
            ? `${rating.ratingInsights.highRatingShare}%`
            : "—",
        },
      ],
    };
  }

  const download = find("download");
  const fans = find("fans");
  const total = download?.totalGames ?? 0;
  const decreased = download?.gamesDecreased ?? 0;

  let stableCount = 0;
  if (download) {
    const flatLabel = download.growthBuckets.find((g) => g.label === "Không đổi")?.count ?? 0;
    const giants =
      download.absoluteBuckets
        .filter((b) => b.min >= 500_001)
        .reduce((s, b) => s + b.count, 0) ?? 0;
    stableCount = Math.min(flatLabel, giants);
  }

  return {
    primaryMetric: "download",
    label: "Game cũ",
    value: pct(decreased, total),
    sub: "game giảm download trong kỳ",
    items: [
      { label: "Giảm download", value: pct(decreased, total) },
      { label: "Khổng lồ ổn định", value: pct(stableCount, total) },
      {
        label: "Fans >100K",
        value: pct(
          fans?.absoluteBuckets
            .filter((b) => b.min >= 100_001)
            .reduce((s, b) => s + b.count, 0) ?? 0,
          fans?.totalGames ?? 0,
        ),
      },
      { label: "Tăng download", value: pct(download?.gamesIncreased ?? 0, total) },
    ],
  };
}

function formatInsightNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function buildSummary(
  endApps: AppSnapshot[],
  periodStart: string | null,
  periodEnd: string | null,
): DistributionSummary {
  const byLifecycle = emptyLifecycleCounts();
  for (const app of endApps) {
    byLifecycle[app.lifecycle] += 1;
  }
  return {
    totalGames: endApps.length,
    byLifecycle,
    periodStart,
    periodEnd,
  };
}

function finalizePeriodCompute(
  endApps: AppSnapshot[],
  startByApp: Map<number, AppSnapshot>,
  metric: DistributionMetric,
  periodStart: Date,
  periodEnd: Date,
): PeriodComputeResult {
  const absoluteBuckets = aggregateBuckets(endApps, startByApp, metric);
  const growth = aggregateGrowthBuckets(endApps, startByApp, metric);

  return {
    absoluteBuckets,
    growthBuckets: growth.buckets,
    gamesIncreased: growth.increased,
    gamesDecreased: growth.decreased,
    gamesFlat: growth.flat,
    ratingInsights:
      metric === "rating" ? computeRatingInsights(endApps, startByApp) : undefined,
    summary: buildSummary(
      endApps,
      periodStart.toISOString().split("T")[0]!,
      periodEnd.toISOString().split("T")[0]!,
    ),
  };
}

function computeSingleMetricFromSnapshots(
  startMap: Map<number, AppRankRow>,
  endMap: Map<number, AppRankRow>,
  metric: DistributionMetric,
  lifecycle: DistributionQuery["lifecycle"],
  periodStart: Date,
  periodEnd: Date,
): PeriodComputeResult {
  const { endApps, startByApp } = buildSnapshots(
    endMap,
    startMap,
    metric,
    lifecycle,
    periodEnd,
  );
  return finalizePeriodCompute(endApps, startByApp, metric, periodStart, periodEnd);
}

function computeSingleMetricFromCohort(
  firstByApp: Map<number, AppRankRow>,
  lastByApp: Map<number, AppRankRow>,
  metric: DistributionMetric,
  tab: DistributionTab,
  periodStart: Date,
  periodEnd: Date,
): PeriodComputeResult {
  const { endApps, startByApp } = buildCohortSnapshots(firstByApp, lastByApp, metric, tab);
  return finalizePeriodCompute(endApps, startByApp, metric, periodStart, periodEnd);
}

async function computeMetricsForPeriod(
  periodStart: Date,
  periodEnd: Date,
  metrics: DistributionMetric[],
  lifecycle: DistributionQuery["lifecycle"],
  cache?: SnapshotCache,
): Promise<Record<DistributionMetric, PeriodComputeResult>> {
  const out = {} as Record<DistributionMetric, PeriodComputeResult>;

  if (isBoardTab(lifecycle)) {
    const { firstByApp, lastByApp } = await fetchTabCohortEdges(
      periodStart,
      periodEnd,
      lifecycle,
    );
    for (const metric of metrics) {
      out[metric] = computeSingleMetricFromCohort(
        firstByApp,
        lastByApp,
        metric,
        lifecycle,
        periodStart,
        periodEnd,
      );
    }
    return out;
  }

  const [startMap, endMap] = await Promise.all([
    fetchSnapshot(periodStart, cache),
    fetchSnapshot(periodEnd, cache),
  ]);

  for (const metric of metrics) {
    out[metric] = computeSingleMetricFromSnapshots(
      startMap,
      endMap,
      metric,
      lifecycle,
      periodStart,
      periodEnd,
    );
  }
  return out;
}

async function computeForPeriod(
  periodStart: Date,
  periodEnd: Date,
  metric: DistributionMetric,
  lifecycle: DistributionQuery["lifecycle"],
  cache?: SnapshotCache,
): Promise<PeriodComputeResult> {
  const results = await computeMetricsForPeriod(
    periodStart,
    periodEnd,
    [metric],
    lifecycle,
    cache,
  );
  return results[metric]!;
}

export class DistributionService {
  async getOverview(query: DistributionOverviewQuery): Promise<DistributionOverviewResponse> {
    const { year = null, month, lifecycle } = query;
    const cacheKey = distributionOverviewCacheKey(year ?? null, lifecycle, month ?? null);

    return getCachedOrFetch(
      cacheKey,
      () => this.buildOverviewBody(year ?? null, month, lifecycle),
      CACHE_TTL,
    );
  }

  async getTrends(query: DistributionOverviewQuery): Promise<DistributionTrendsResponse> {
    const { year = null, month, lifecycle } = query;
    const cacheKey = distributionTrendsCacheKey(year ?? null, lifecycle, month ?? null);

    return getCachedOrFetch(
      cacheKey,
      async () => {
        const metrics = METRICS_BY_TAB[lifecycle];
        const trendsByMetric = await this.buildTrends(year, month, lifecycle, metrics);
        return {
          lifecycle,
          year,
          month: month ?? null,
          metrics: metrics.map((metric) => ({
            metric,
            trend: trendsByMetric[metric] ?? [],
          })),
        };
      },
      CACHE_TTL,
    );
  }

  private async buildOverviewBody(
    year: number | null,
    month: number | undefined,
    lifecycle: DistributionTab,
  ): Promise<DistributionOverviewResponse> {
    const metrics = METRICS_BY_TAB[lifecycle];
    const { periodStart, periodEnd } = await resolvePeriodBounds(year, month);

    if (!periodStart || !periodEnd) {
      return {
        lifecycle,
        year: year ?? null,
        month: month ?? null,
        periodStart: null,
        periodEnd: null,
        segmentCounts: emptyLifecycleCounts(),
        segmentTotal: 0,
        metrics: metrics.map((m) => ({
          metric: m,
          label: METRIC_LABELS[m],
          buckets: emptyMetricBuckets(m),
          absoluteBuckets: emptyMetricBuckets(m),
          growthBuckets: emptyGrowthBuckets(m),
          totalGames: 0,
          metricSum: 0,
          metricDelta: 0,
          gamesWithGrowth: 0,
          gamesIncreased: 0,
          gamesDecreased: 0,
          gamesFlat: 0,
          trend: [],
        })),
        tabInsights: computeTabInsights(lifecycle, []),
        message: "Không có dữ liệu crawl trong kỳ đã chọn",
      };
    }

    let firstByApp: Map<number, AppRankRow>;
    let lastByApp: Map<number, AppRankRow>;
    let segmentCounts: Record<DistributionLifecycle, number>;

    if (lifecycle === "reserve") {
      ({ firstByApp, lastByApp } = await fetchTabCohortEdges(periodStart, periodEnd, lifecycle));
      segmentCounts = { ...emptyLifecycleCounts(), reserve: lastByApp.size };
    } else {
      const launched = await fetchBoardCohortEdgesCached(periodStart, periodEnd, "launched");
      ({ firstByApp, lastByApp } = filterTabCohortEdges(launched, lifecycle));
      const reserveCount = await fetchReserveDistinctCount(periodStart, periodEnd);
      segmentCounts = segmentCountsFromLaunchedLast(launched.lastByApp, reserveCount);
    }
    const segmentTotal = segmentCounts[lifecycle];

    const metricResultMap = {} as Record<DistributionMetric, PeriodComputeResult>;
    for (const metric of metrics) {
      metricResultMap[metric] = computeSingleMetricFromCohort(
        firstByApp,
        lastByApp,
        metric,
        lifecycle,
        periodStart,
        periodEnd,
      );
    }

    const metricBlocks = metrics.map((m) => metricBlockFromResult(m, metricResultMap[m]!, []));

    return {
      lifecycle,
      year: year ?? null,
      month: month ?? null,
      periodStart: periodStart.toISOString().split("T")[0]!,
      periodEnd: periodEnd.toISOString().split("T")[0]!,
      segmentCounts,
      segmentTotal,
      metrics: metricBlocks,
      tabInsights: computeTabInsights(lifecycle, metricBlocks),
    };
  }

  private async buildTrends(
    year: number | null | undefined,
    month: number | undefined,
    lifecycle: DistributionTab,
    metrics: DistributionMetric[],
  ): Promise<Record<DistributionMetric, DistributionTrendPoint[]>> {
    const out = {} as Record<DistributionMetric, DistributionTrendPoint[]>;
    for (const m of metrics) out[m] = [];

    if (month != null) return out;

    if (year != null) {
      const monthlyBounds = await resolveMonthlyBoundsForYear(year);
      const monthEntries = [...monthlyBounds.entries()].sort(([a], [b]) => a - b);
      const monthResults = await runWithConcurrency(
        monthEntries.map(([m, bounds]) => async () => ({
          month: m,
          results: await computeMetricsForPeriod(
            bounds.periodStart,
            bounds.periodEnd,
            metrics,
            lifecycle,
          ),
        })),
        TRENDS_MONTH_CONCURRENCY,
      );
      for (const { month: m, results } of monthResults) {
        for (const metric of metrics) {
          const r = results[metric]!;
          out[metric]!.push({
            key: `${year}-${String(m).padStart(2, "0")}`,
            label: `T${m}`,
            periodStart: r.summary.periodStart,
            periodEnd: r.summary.periodEnd,
            totalGames: r.summary.totalGames,
            metricSum: r.absoluteBuckets.reduce((s, b) => s + b.metricSum, 0),
            metricDelta: r.absoluteBuckets.reduce((s, b) => s + b.metricDelta, 0),
          });
        }
      }
      return out;
    }

    const meta = await this.getMeta();
    for (const y of [...meta.years].sort((a, b) => a - b)) {
      const { periodStart, periodEnd } = await resolvePeriodBounds(y);
      if (!periodStart || !periodEnd) continue;
      const results = await computeMetricsForPeriod(
        periodStart,
        periodEnd,
        metrics,
        lifecycle,
      );
      for (const metric of metrics) {
        const r = results[metric]!;
        out[metric]!.push({
          key: String(y),
          label: String(y),
          periodStart: r.summary.periodStart,
          periodEnd: r.summary.periodEnd,
          totalGames: r.summary.totalGames,
          metricSum: r.absoluteBuckets.reduce((s, b) => s + b.metricSum, 0),
          metricDelta: r.absoluteBuckets.reduce((s, b) => s + b.metricDelta, 0),
        });
      }
    }
    return out;
  }

  async getMeta(): Promise<DistributionMeta> {
    return getCachedOrFetch(DISTRIBUTION_META_CACHE_KEY, async () => {
      const { rows } = await pool.query<{ year: number; month: number }>(
        `SELECT DISTINCT EXTRACT(YEAR FROM "date")::int AS year,
                EXTRACT(MONTH FROM "date")::int AS month
         FROM "AppRank"
         ORDER BY year DESC, month DESC`,
      );

      const yearSet = new Set<number>();
      const monthsByYear = new Map<number, number[]>();

      for (const r of rows) {
        yearSet.add(r.year);
        const list = monthsByYear.get(r.year) ?? [];
        list.push(r.month);
        monthsByYear.set(r.year, list);
      }

      const years = [...yearSet].sort((a, b) => b - a);
      const months: Record<number, number[]> = {};
      for (const y of years) {
        months[y] = (monthsByYear.get(y) ?? []).sort((a, b) => a - b);
      }

      return {
        years,
        months,
        metrics: (["reserve", "download", "rating", "reviewCount", "fans"] as DistributionMetric[]).map(
          (id) => ({ id, label: METRIC_LABELS[id] }),
        ),
        bucketDefinitions: {
          reserve: COUNT_BUCKETS,
          download: COUNT_BUCKETS,
          fans: COUNT_BUCKETS,
          rating: RATING_BUCKETS,
          reviewCount: REVIEW_BUCKETS,
        },
        growthBucketDefinitions: {
          count: COUNT_GROWTH_BUCKETS,
          rating: RATING_GROWTH_BUCKETS,
        },
      };
    }, CACHE_TTL);
  }

  async getDistribution(query: DistributionQuery): Promise<DistributionResponse> {
    const { year, month, metric, lifecycle } = query;
    const cacheKey = `distribution-v1-${year}-${month ?? "all"}-${metric}-${lifecycle}`;

    return getCachedOrFetch(
      cacheKey,
      async () => {
        if (month != null) {
          const { periodStart, periodEnd } = await resolvePeriodBounds(year, month);
          if (!periodStart || !periodEnd) {
            return {
              mode: "month" as const,
              metric,
              lifecycle,
              year,
              month,
              buckets: bucketsForMetric(metric).map((b) => ({
                label: b.label,
                min: b.min,
                max: b.max,
                count: 0,
                countDelta: 0,
                metricSum: 0,
                metricDelta: 0,
                byLifecycle: emptyLifecycleCounts(),
              })),
              summary: {
                totalGames: 0,
                byLifecycle: emptyLifecycleCounts(),
                periodStart: null,
                periodEnd: null,
              },
              message: "Không có dữ liệu crawl trong tháng đã chọn",
            };
          }

          const { absoluteBuckets, summary } = await computeForPeriod(
            periodStart,
            periodEnd,
            metric,
            lifecycle,
          );

          return {
            mode: "month",
            metric,
            lifecycle,
            year,
            month,
            buckets: absoluteBuckets,
            summary,
          };
        }

        const monthlyTrend: DistributionMonthlyPoint[] = [];
        for (let m = 1; m <= 12; m++) {
          const { periodStart, periodEnd } = await resolvePeriodBounds(year, m);
          if (!periodStart || !periodEnd) {
            monthlyTrend.push({
              month: m,
              periodStart: null,
              periodEnd: null,
              totalGames: 0,
              totalMetricSum: 0,
              totalMetricDelta: 0,
            });
            continue;
          }

          const { absoluteBuckets, summary } = await computeForPeriod(
            periodStart,
            periodEnd,
            metric,
            lifecycle,
          );

          const totalMetricSum = absoluteBuckets.reduce((s, b) => s + b.metricSum, 0);
          const totalMetricDelta = absoluteBuckets.reduce((s, b) => s + b.metricDelta, 0);

          monthlyTrend.push({
            month: m,
            periodStart: summary.periodStart,
            periodEnd: summary.periodEnd,
            totalGames: summary.totalGames,
            totalMetricSum,
            totalMetricDelta,
          });
        }

        const yearBounds = await resolvePeriodBounds(year);
        let yearBuckets = bucketsForMetric(metric).map((b) => ({
          label: b.label,
          min: b.min,
          max: b.max,
          count: 0,
          countDelta: 0,
          metricSum: 0,
          metricDelta: 0,
          byLifecycle: emptyLifecycleCounts(),
        }));
        let yearSummary: DistributionSummary = {
          totalGames: 0,
          byLifecycle: emptyLifecycleCounts(),
          periodStart: yearBounds.periodStart?.toISOString().split("T")[0] ?? null,
          periodEnd: yearBounds.periodEnd?.toISOString().split("T")[0] ?? null,
        };
        if (yearBounds.periodStart && yearBounds.periodEnd) {
          const computed = await computeForPeriod(
            yearBounds.periodStart,
            yearBounds.periodEnd,
            metric,
            lifecycle,
          );
          yearBuckets = computed.absoluteBuckets;
          yearSummary = computed.summary;
        }
        return {
          mode: "year",
          metric,
          lifecycle,
          year,
          monthlyTrend,
          buckets: yearBuckets,
          summary: yearSummary,
        };
      },
      CACHE_TTL,
    );
  }
}

export const distributionService = new DistributionService();
