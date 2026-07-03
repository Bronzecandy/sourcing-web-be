import { pool } from "../utils/prisma";
import { getCachedOrFetch } from "../utils/cache";
import type {
  PotentialScoreResult,
  PotentialScaleMetric,
  GamePotentialDetail,
  PotentialBreakdown,
} from "../types";
import {
  APP_RANK_LIGHT_SELECT_SQL,
  APP_RANK_APP_DATE_RANGE_SQL,
  type AppRankRow,
  type LaunchCategory,
  type PotentialSegment,
  classifyLaunchCategory,
  hasLaunchedRank,
  hasReserveRank,
  activeLaunchBoards,
  computeAppLifecycle,
  launchedPriorityRank,
  primaryLaunchBoard,
  rankForLaunchBoard,
  type PrimaryLaunchBoard,
  releaseDateFromRaw,
  reserveRank,
  type AppLifecycleMeta,
} from "../utils/app-rank";
import { downloadCountFromRaw } from "../utils/taptap-raw-extract";
import {
  ensurePotentialScorers,
  mergeAudienceScore,
  percentileAnchorsFromSample,
  percentileRankOf,
  ratingDeltaAdjustment,
  ratingStartBase,
  tierAbsScale,
  tierGrowthDelta,
  type PercentileAnchors,
} from "../utils/distribution-percentile";

// Distribution tier pillars; bump when the formula changes so caches refresh.
const ALGO_VERSION_RESERVE = "v12";
const ALGO_VERSION_LAUNCHED = "v18";
const BREAKDOWN_VERSION = "v12";

const GROWTH_CALIBRATION_WINDOWS = [7, 14, 30] as const;
const GROWTH_CALIBRATION_TTL_MS = Math.max(
  60_000,
  parseInt(process.env.GROWTH_CALIBRATION_TTL_MS ?? "21600000", 10) || 21_600_000,
);

interface GrowthCalibration {
  sortedPerDay: number[];
  anchors: PercentileAnchors;
}

const growthCalibrationCache = new Map<string, GrowthCalibration>();
let growthCalibrationBuiltAt = 0;
let growthCalibrationInFlight: Promise<void> | null = null;

/** Base chart-quality score by primary board (Pop > Hot > New). */
const LAUNCH_CHART_BASE: Record<PrimaryLaunchBoard, number> = {
  pop: 100,
  hot: 65,
  new: 35,
};

/** Launch-board subscore weights — sum to 1.0, output 0–100. */
const LAUNCH_BOARD_SUB_WEIGHTS = {
  chartQuality: 0.6,
  consistency: 0.25,
  coverage: 0.15,
} as const;

/** Reserve composite weights — must sum to 1.0. */
const RESERVE_COMPOSITE_WEIGHTS = {
  audience: 0.65,
  rating: 0.25,
  rankQuality: 0.1,
} as const;

/** Launched composite weights — must sum to 1.0. */
const LAUNCHED_COMPOSITE_WEIGHTS = {
  audience: 0.45,
  rating: 0.15,
  rankQuality: 0.2,
  launchBoard: 0.15,
  preLaunch: 0.05,
} as const;

/** Rank-quality pillar sub-weights — must sum to 1.0. */
const RANK_QUALITY_SUB_WEIGHTS = {
  positionQuality: 0.4,
  presence: 0.2,
  streak: 0.1,
  volatility: 0.1,
  movement: 0.2,
} as const;

const TOP_CHART = 10;

/** When audience & rating are strong, rank chart cannot drag composite below core − margin. */
const COMPOSITE_FLOOR_AUDIENCE_MIN = 70;
const COMPOSITE_FLOOR_RATING_MIN = 55;
const COMPOSITE_FLOOR_MARGIN = 2;

export class RankingService {
  /** Multi-board coverage snapshot (0–100) for latest day. */
  private static launchCoverageScore(active: Set<PrimaryLaunchBoard>): number {
    const p = active.has("pop");
    const h = active.has("hot");
    const n = active.has("new");
    if (p && h && n) return 100;
    if (p && h) return 85;
    if (p && n) return 70;
    if (p) return 55;
    if (h && n) return 40;
    if (h) return 25;
    if (n) return 10;
    return 0;
  }

  private static clamp(v: number, lo = 0, hi = 100) {
    return Math.max(lo, Math.min(hi, v));
  }

  private static r1(v: number) {
    return Math.round(v * 10) / 10;
  }

  /** Growth-table score: 60% growth norm + 20% rating + 20% rank quality. */
  private static computeMomentumScore(
    growthNorm: number,
    ratingScore: number,
    rankQualityScore: number,
  ): number {
    const C = RankingService.clamp;
    const R = RankingService.r1;
    return R(0.6 * C(growthNorm) + 0.2 * C(ratingScore) + 0.2 * C(rankQualityScore));
  }

  private static calibrationKey(
    segment: PotentialSegment,
    platform: "combined" | "android" | "ios",
  ): string {
    return `${segment}-${platform}`;
  }

  private deltaPerDayForAppRows(
    appRows: AppRankRow[],
    windowDays: number,
    platform: "combined" | "android" | "ios",
    segment: PotentialSegment,
  ): number | null {
    const getRank = (r: AppRankRow) => this.getRankForSegment(r, segment, platform);
    const rowsForScore = segment === "launched" ? this.slicePostLaunchRows(appRows) : appRows;
    const validRows = rowsForScore.filter((r) => getRank(r) != null);
    if (validRows.length < 2) return null;

    const scaleValues =
      segment === "launched"
        ? validRows.map((r) => this.downloadCountForRow(r))
        : validRows.map((r) => r.reserveCount ?? null);

    const valid = scaleValues.filter((v): v is number => v != null && v > 0);
    if (valid.length < 2) return null;

    const start = valid[0]!;
    const end = valid[valid.length - 1]!;
    const delta = end - start;
    return delta / windowDays;
  }

  private sliceAppRowsForWindow(appRows: AppRankRow[], windowDays: number): AppRankRow[] {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - windowDays);
    return appRows.filter((r) => r.date >= cutoff);
  }

  private async buildGrowthCalibrationForSegment(
    segment: PotentialSegment,
    platform: "combined" | "android" | "ios",
  ): Promise<GrowthCalibration> {
    const perDaySamples: number[] = [];
    const maxWindow = Math.max(...GROWTH_CALIBRATION_WINDOWS);
    const rows = await this.fetchLightRows(maxWindow);
    const grouped = new Map<number, AppRankRow[]>();
    for (const row of rows) {
      if (!grouped.has(row.appId)) grouped.set(row.appId, []);
      grouped.get(row.appId)!.push(row);
    }

    for (const windowDays of GROWTH_CALIBRATION_WINDOWS) {
      for (const [, appRows] of grouped) {
        if (segment === "reserve" && !this.isReserveOnlyApp(appRows)) continue;
        if (segment === "launched" && !this.isLaunchedApp(appRows)) continue;
        const windowRows = this.sliceAppRowsForWindow(appRows, windowDays);
        const perDay = this.deltaPerDayForAppRows(windowRows, windowDays, platform, segment);
        if (perDay != null && Number.isFinite(perDay)) perDaySamples.push(perDay);
      }
    }

    perDaySamples.sort((a, b) => a - b);
    return {
      sortedPerDay: perDaySamples,
      anchors: percentileAnchorsFromSample(perDaySamples),
    };
  }

  private async ensureGrowthCalibration(
    platform: "combined" | "android" | "ios",
    force = false,
  ): Promise<void> {
    const stale = Date.now() - growthCalibrationBuiltAt > GROWTH_CALIBRATION_TTL_MS;
    if (!force && !stale && growthCalibrationCache.size >= 2) return;
    if (growthCalibrationInFlight) return growthCalibrationInFlight;

    growthCalibrationInFlight = (async () => {
      for (const segment of ["reserve", "launched"] as const) {
        const key = RankingService.calibrationKey(segment, platform);
        growthCalibrationCache.set(
          key,
          await this.buildGrowthCalibrationForSegment(segment, platform),
        );
      }
      growthCalibrationBuiltAt = Date.now();
    })().finally(() => {
      growthCalibrationInFlight = null;
    });

    return growthCalibrationInFlight;
  }

  private static absoluteGrowthCap(
    deltaPerDay: number,
    segment: PotentialSegment,
    platform: "combined" | "android" | "ios",
  ): number {
    const key = RankingService.calibrationKey(segment, platform);
    const cal = growthCalibrationCache.get(key);
    if (!cal || cal.sortedPerDay.length === 0) {
      const bonus = tierGrowthDelta(deltaPerDay * 14)?.points ?? 0;
      return RankingService.clamp(50 + bonus);
    }
    return percentileRankOf(deltaPerDay, cal.sortedPerDay);
  }

  private static growthCalibrationAnchors(
    segment: PotentialSegment,
    platform: "combined" | "android" | "ios",
  ): PercentileAnchors | undefined {
    return growthCalibrationCache.get(RankingService.calibrationKey(segment, platform))?.anchors;
  }

  private applyGrowthMomentumPostPass(
    results: PotentialScoreResult[],
    days: number,
    platform: "combined" | "android" | "ios",
    segment: PotentialSegment,
  ): PotentialScoreResult[] {
    const R = RankingService.r1;
    const C = RankingService.clamp;
    const anchors = RankingService.growthCalibrationAnchors(segment, platform);

    const sortedDeltas = results
      .map((r) => r.audienceGrowthAbsolute ?? 0)
      .sort((a, b) => a - b);
    const cohortSize = results.length;

    return results.map((r) => {
      const delta = r.audienceGrowthAbsolute ?? 0;
      const cohortPct = percentileRankOf(delta, sortedDeltas);
      const deltaPerDay = delta / Math.max(days, 1);
      const absCap = RankingService.absoluteGrowthCap(deltaPerDay, segment, platform);
      const growthNorm = C(Math.min(cohortPct, absCap));
      const momentumScore = RankingService.computeMomentumScore(
        growthNorm,
        r.ratingScore,
        r.rankQualityScore,
      );

      return {
        ...r,
        momentumScore,
        momentumGrowthNorm: R(growthNorm),
        momentumGrowthPercentile: R(cohortPct),
        momentumGrowthAbsCap: R(absCap),
        momentumGrowthCohortSize: cohortSize,
        momentumGrowthPerDayAnchors: anchors,
      };
    });
  }

  private momentumFieldsFromListEntry(
    entry: PotentialScoreResult | undefined,
    detail: GamePotentialDetail,
    days: number,
    platform: "combined" | "android" | "ios",
    segment: PotentialSegment,
  ): Pick<
    GamePotentialDetail,
    | "momentumScore"
    | "momentumGrowthNorm"
    | "momentumGrowthPercentile"
    | "momentumGrowthAbsCap"
    | "momentumGrowthCohortSize"
    | "momentumGrowthPerDayAnchors"
    | "momentumMovementScore"
  > {
    const R = RankingService.r1;
    if (entry?.momentumScore != null && entry.momentumGrowthNorm != null) {
      return {
        momentumScore: entry.momentumScore,
        momentumGrowthNorm: entry.momentumGrowthNorm,
        momentumGrowthPercentile: entry.momentumGrowthPercentile,
        momentumGrowthAbsCap: entry.momentumGrowthAbsCap,
        momentumGrowthCohortSize: entry.momentumGrowthCohortSize,
        momentumGrowthPerDayAnchors: entry.momentumGrowthPerDayAnchors,
        momentumMovementScore: entry.momentumMovementScore,
      };
    }

    const aud = detail.audience;
    const audienceDelta = aud.start != null && aud.end != null ? aud.delta : 0;
    const deltaPerDay = audienceDelta / Math.max(days, 1);
    const absCap = RankingService.absoluteGrowthCap(
      deltaPerDay,
      segment,
      platform,
    );
    const growthNorm = RankingService.clamp(absCap);
    const momentumScore = RankingService.computeMomentumScore(
      growthNorm,
      detail.rating.score,
      detail.rankQuality.score,
    );
    return {
      momentumScore,
      momentumGrowthNorm: R(growthNorm),
      momentumGrowthPercentile: undefined,
      momentumGrowthAbsCap: R(absCap),
      momentumGrowthCohortSize: undefined,
      momentumGrowthPerDayAnchors: RankingService.growthCalibrationAnchors(segment, platform),
      momentumMovementScore: R(detail.rankQuality.movementScore),
    };
  }

  /** Stricter rank tiers: rewards consistent top-10/20, not just "in top 200". */
  private static rankTierScore(rank: number): number {
    if (rank <= 10) return 100;
    if (rank <= 20) return 80;
    if (rank <= 50) return 55;
    if (rank <= 100) return 30;
    if (rank <= 200) return 12;
    return 0;
  }

  /** Renormalized weighted mean — pillars with null score are dropped from the blend. */
  private static weightedComposite(parts: Array<{ score: number | null; weight: number }>): number {
    let sum = 0;
    let wsum = 0;
    for (const p of parts) {
      if (p.score == null || Number.isNaN(p.score)) continue;
      sum += p.score * p.weight;
      wsum += p.weight;
    }
    return wsum > 0 ? RankingService.clamp(sum / wsum) : 50;
  }

  private static absThreshold(days: number): number {
    if (days <= 7) return 50_000;
    if (days <= 14) return 100_000;
    return 200_000;
  }

  // --------------------------------------------------------------------------
  // Pillars
  // --------------------------------------------------------------------------

  /** Merged audience: scale base tier + growth bonus (forgiving when base is large). */
  private scoreAudience(values: (number | null)[], metric: PotentialScaleMetric) {
    const valid = values.filter((v): v is number => v != null && v > 0);
    const start = valid.length >= 2 ? valid[0]! : valid.length === 1 ? valid[0]! : null;
    const end = valid.length >= 1 ? valid[valid.length - 1]! : null;
    const delta = start != null && end != null ? end - start : 0;

    const absTier = tierAbsScale(end ?? start);
    const growthTier = tierGrowthDelta(start != null && end != null ? delta : 0);
    const baseValue = absTier?.points ?? 0;
    const growthBonus = growthTier?.points ?? 0;
    const merged = mergeAudienceScore(baseValue, growthBonus);

    return {
      score: merged.score,
      metric,
      start,
      end,
      delta,
      baseValue,
      baseTierLabel: absTier?.label ?? null,
      growthBonus,
      growthTierLabel: growthTier?.label ?? null,
      growthWeight: merged.growthWeight,
    };
  }

  /** Rating: base from period-start level + ±5 per 0.1 change. */
  private scoreRating(ratings: (string | null)[]) {
    const R = RankingService.r1;
    const valid = ratings
      .filter((r): r is string => r !== null)
      .map(Number)
      .filter((n) => !Number.isNaN(n));
    const start = valid.length >= 2 ? valid[0]! : valid.length === 1 ? valid[0]! : null;
    const end = valid.length >= 1 ? valid[valid.length - 1]! : null;
    const delta = start != null && end != null ? end - start : 0;

    const baseValue = start != null ? ratingStartBase(start) : end != null ? ratingStartBase(end) : 0;
    const deltaAdj = start != null && end != null ? ratingDeltaAdjustment(delta) : 0;
    const score = start != null ? RankingService.clamp(baseValue + deltaAdj) : null;

    return {
      score: score != null ? R(score) : null,
      start,
      end,
      delta: R(delta),
      baseValue: R(baseValue),
      deltaAdjustment: R(deltaAdj),
    };
  }

  /** Consolidated rank quality + stability. */
  private scoreRankQuality(ranks: number[], analysisDays: number) {
    const C = RankingService.clamp;
    const R = RankingService.r1;
    const n = ranks.length;

    const positionQuality = ranks.reduce((a, r) => a + RankingService.rankTierScore(r), 0) / n;

    const top10 = ranks.filter((r) => r <= 10).length;
    const top20 = ranks.filter((r) => r <= 20).length;
    const top50 = ranks.filter((r) => r <= 50).length;
    const top10Rate = (top10 / n) * 100;
    const top20Rate = (top20 / n) * 100;
    const top50Rate = (top50 / n) * 100;

    let longest = 0;
    let cur = 0;
    for (const r of ranks) {
      if (r <= 20) {
        cur++;
        longest = Math.max(longest, cur);
      } else cur = 0;
    }
    const longestTop20Streak = Math.min(longest, analysisDays);
    const streakScore = C((longestTop20Streak / analysisDays) * 100);

    const mean = ranks.reduce((a, b) => a + b, 0) / n;
    const variance = ranks.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    const stdDev = Math.sqrt(variance);
    const volatilityScore = C(100 - stdDev * 2);

    const rankStart = ranks[0]!;
    const rankEnd = ranks[ranks.length - 1]!;
    const change = rankStart - rankEnd;

    let climbScore: number;
    if (change > 0) {
      const abs = C(50 + change);
      const rel = C(50 + (change / Math.max(rankStart - 1, 1)) * 50);
      climbScore = Math.max(abs, rel);
    } else if (change === 0) {
      climbScore = 50;
    } else {
      let abs = C(50 + change);
      if (rankStart <= TOP_CHART && rankEnd <= TOP_CHART) abs = C(50 + change * 0.4);
      const rel = C(50 + (change / Math.max(n, 1)) * 50);
      climbScore = Math.max(abs, rel);
    }
    let maintenanceScore = 0;
    if (rankEnd <= TOP_CHART) {
      maintenanceScore = C(100 - rankEnd * 0.5);
      if (rankEnd === 1 && change === 0) maintenanceScore = 100;
      else if (change === 0) maintenanceScore = C(100 - rankEnd * 0.45);
    }
    const movementScore = C(Math.max(climbScore, maintenanceScore));

    const bestRank = Math.min(...ranks);

    const w = RANK_QUALITY_SUB_WEIGHTS;
    const score = C(
      positionQuality * w.positionQuality +
        top20Rate * w.presence +
        streakScore * w.streak +
        volatilityScore * w.volatility +
        movementScore * w.movement,
    );

    return {
      score,
      positionQuality: R(positionQuality),
      top10Rate: R(top10Rate),
      top20Rate: R(top20Rate),
      top50Rate: R(top50Rate),
      presenceScore: R(top20Rate),
      streakScore: R(streakScore),
      volatilityScore: R(volatilityScore),
      movementScore: R(movementScore),
      avgRank: R(mean),
      bestRank,
      rankStart,
      rankEnd,
      change,
      stdDev: R(stdDev),
      longestTop20Streak,
      daysTracked: n,
    };
  }

  private scoreConfidence(dataPoints: number, analysisDays: number) {
    const coverage = Math.min(dataPoints / analysisDays, 1);
    return {
      coverage: RankingService.r1(coverage * 100),
      /** @deprecated Not applied to scores — informational coverage only. */
      multiplier: 1,
      dataPoints: Math.min(dataPoints, analysisDays),
      analysisDays,
    };
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private getRankForSegment(
    row: AppRankRow,
    segment: PotentialSegment,
    platform: "combined" | "android" | "ios",
  ): number | null {
    return segment === "reserve" ? reserveRank(row, platform) : launchedPriorityRank(row, platform);
  }

  private algoVersion(segment: PotentialSegment): string {
    return segment === "launched" ? ALGO_VERSION_LAUNCHED : ALGO_VERSION_RESERVE;
  }

  private scaleMetricForSegment(segment: PotentialSegment): PotentialScaleMetric {
    return segment === "launched" ? "download" : "reserve";
  }

  /** Reserve-only apps: has reserve history and no hot/pop/new on latest snapshot in window. */
  private isReserveOnlyApp(appRows: AppRankRow[]): boolean {
    const latest = appRows[appRows.length - 1];
    return hasReserveRank(latest) && !hasLaunchedRank(latest);
  }

  /** Launched apps: at least one day with hot/pop/new rank in window. */
  private isLaunchedApp(appRows: AppRankRow[]): boolean {
    return appRows.some((r) => hasLaunchedRank(r));
  }

  /** Rows from first day on Hot/Pop/New boards onward. */
  private slicePostLaunchRows(appRows: AppRankRow[]): AppRankRow[] {
    const idx = appRows.findIndex((r) => hasLaunchedRank(r));
    if (idx < 0) return [];
    return appRows.slice(idx);
  }

  private async fetchFirstLaunchDate(appId: number): Promise<Date | null> {
    const { rows } = await pool.query<{ d: Date }>(
      `SELECT MIN("date") AS d FROM "AppRank"
       WHERE "appId" = $1 AND (
         "hotAndroidRank" IS NOT NULL OR "hotIosRank" IS NOT NULL OR
         "popAndroidRank" IS NOT NULL OR "popIosRank" IS NOT NULL OR
         "newAndroidRank" IS NOT NULL OR "newIosRank" IS NOT NULL
       )`,
      [appId],
    );
    return rows[0]?.d ?? null;
  }

  private async fetchAppRowsInRange(
    appId: number,
    fromInclusive: Date,
    toExclusive: Date,
  ): Promise<AppRankRow[]> {
    const { rows } = await pool.query<AppRankRow>(APP_RANK_APP_DATE_RANGE_SQL, [
      appId,
      fromInclusive,
      toExclusive,
    ]);
    return rows;
  }

  /**
   * Reserve: if app ever launched, use N days ending at first launch (no post-launch gap).
   * Launch: rolling window from today.
   */
  private async resolveAppRowsForScoring(
    appId: number,
    days: number,
    segment: PotentialSegment,
  ): Promise<AppRankRow[]> {
    if (segment === "launched") {
      const rows = await this.fetchLightRows(days);
      return rows.filter((r) => r.appId === appId);
    }

    const firstLaunch = await this.fetchFirstLaunchDate(appId);
    if (firstLaunch) {
      const toExclusive = new Date(firstLaunch);
      toExclusive.setUTCHours(0, 0, 0, 0);
      const fromInclusive = new Date(toExclusive);
      fromInclusive.setDate(fromInclusive.getDate() - days);
      return this.fetchAppRowsInRange(appId, fromInclusive, toExclusive);
    }

    const rows = await this.fetchLightRows(days);
    return rows.filter((r) => r.appId === appId);
  }

  /** +0–3 bonus for strong reserve growth before first launch in window. */
  private scorePreLaunchReserveBonus(appRows: AppRankRow[]): number {
    const launchIdx = appRows.findIndex((r) => hasLaunchedRank(r));
    if (launchIdx <= 0) return 0;
    const pre = appRows
      .slice(0, launchIdx)
      .filter((r) => r.reserveCount != null && r.reserveCount > 0);
    if (pre.length < 2) return 0;
    const start = pre[0]!.reserveCount!;
    const end = pre[pre.length - 1]!.reserveCount!;
    const growth = end - start;
    if (growth <= 0) return 0;
    const rate = start >= 50 ? growth / start : 0;
    const absScore = RankingService.clamp((growth / RankingService.absThreshold(14)) * 100);
    const rateScore = rate > 0 ? RankingService.clamp(rate * 200) : 0;
    return RankingService.clamp(Math.max(absScore, rateScore) / 33, 0, 3);
  }

  private downloadCountForRow(row: AppRankRow): number | null {
    if (row.downloadCount != null && row.downloadCount > 0) return Number(row.downloadCount);
    return downloadCountFromRaw(row.raw);
  }

  /** Launch-board breadth pillar (chart quality + consistency + coverage). */
  private scoreLaunchBoard(
    validRows: AppRankRow[],
    platform: "combined" | "android" | "ios",
  ) {
    const C = RankingService.clamp;
    const R = RankingService.r1;
    const latest = validRows[validRows.length - 1]!;
    const primaryBoard = primaryLaunchBoard(latest, platform);
    const primaryRank = primaryBoard ? launchedPriorityRank(latest, platform) : null;

    let chartQuality = 0;
    if (primaryBoard) {
      const rank = primaryRank ?? 200;
      const rankFactor = C(100 - rank * 0.5) / 100;
      chartQuality = C(LAUNCH_CHART_BASE[primaryBoard] * rankFactor);
    }

    const n = validRows.length;
    let popDays = 0;
    let hotDays = 0;
    let newDays = 0;
    for (const row of validRows) {
      if (rankForLaunchBoard(row, "pop", platform) != null) popDays++;
      if (rankForLaunchBoard(row, "hot", platform) != null) hotDays++;
      if (rankForLaunchBoard(row, "new", platform) != null) newDays++;
    }
    const consistency = C((popDays / n) * 60 + (hotDays / n) * 25 + (newDays / n) * 15);

    const active = new Set(activeLaunchBoards(latest, platform).map((t) => t.board));
    const coverage = RankingService.launchCoverageScore(active);

    const sw = LAUNCH_BOARD_SUB_WEIGHTS;
    const score = C(
      chartQuality * sw.chartQuality + consistency * sw.consistency + coverage * sw.coverage,
      0,
      100,
    );

    return {
      primaryBoard,
      primaryRank,
      score: R(score),
      chartQuality: R(chartQuality),
      consistency: R(consistency),
      coverage: R(coverage),
      popDayRate: R((popDays / n) * 100),
      hotDayRate: R((hotDays / n) * 100),
      newDayRate: R((newDays / n) * 100),
      activeBoardCount: active.size,
      activeBoards: activeLaunchBoards(latest, platform),
    };
  }

  private launchCategoryForApp(appRows: AppRankRow[]): LaunchCategory | undefined {
    for (let i = appRows.length - 1; i >= 0; i--) {
      const cat = classifyLaunchCategory(appRows[i]!);
      if (cat) return cat;
    }
    const rel = releaseDateFromRaw(appRows[appRows.length - 1]?.raw);
    if (rel) {
      const daysSince = (Date.now() - rel.getTime()) / (86400 * 1000);
      if (daysSince <= 60) return "new_launch";
    }
    return "established_launch";
  }

  // --------------------------------------------------------------------------
  // Core scoring (shared by list + detail)
  // --------------------------------------------------------------------------

  private computePillars(
    appRows: AppRankRow[],
    days: number,
    platform: "combined" | "android" | "ios",
    segment: PotentialSegment,
  ): {
    detail: GamePotentialDetail;
    validRows: AppRankRow[];
  } | null {
    const getRank = (r: AppRankRow) => this.getRankForSegment(r, segment, platform);
    const rowsForScore = segment === "launched" ? this.slicePostLaunchRows(appRows) : appRows;
    const validRows = rowsForScore.filter((r) => getRank(r) != null);

    const rel = releaseDateFromRaw(appRows[appRows.length - 1]?.raw);
    const releaseRecent = rel != null && (Date.now() - rel.getTime()) / 86400000 <= 60;
    const minPoints = segment === "launched" && releaseRecent ? 2 : 3;
    if (validRows.length < minPoints) return null;

    const analysisDays = days;
    const scaleMetric = this.scaleMetricForSegment(segment);

    const ranks = validRows.map((r) => getRank(r)!);
    const ratings = validRows.map((r) => r.rating ?? null);
    const scaleValues =
      segment === "launched"
        ? validRows.map((r) => this.downloadCountForRow(r))
        : validRows.map((r) => r.reserveCount ?? null);

    const audience = this.scoreAudience(scaleValues, scaleMetric);
    const rating = this.scoreRating(ratings);
    const rankQuality = this.scoreRankQuality(ranks, analysisDays);

    const confidence = this.scoreConfidence(validRows.length, analysisDays);

    let launchBoard: ReturnType<RankingService["scoreLaunchBoard"]> | undefined;
    let preLaunchRaw = 0;
    let rawComposite: number;
    let floorApplied = false;

    const coreComposite = RankingService.weightedComposite([
      { score: audience.score, weight: 1 },
      { score: rating.score, weight: 1 },
    ]);

    const applyCompositeFloor = (composite: number): number => {
      if (
        audience.score >= COMPOSITE_FLOOR_AUDIENCE_MIN &&
        rating.score != null &&
        rating.score >= COMPOSITE_FLOOR_RATING_MIN
      ) {
        const floor = coreComposite - COMPOSITE_FLOOR_MARGIN;
        if (composite < floor) {
          floorApplied = true;
          return RankingService.clamp(floor);
        }
      }
      return composite;
    };

    if (segment === "launched") {
      launchBoard = this.scoreLaunchBoard(validRows, platform);
      preLaunchRaw = this.scorePreLaunchReserveBonus(appRows);
      const preLaunchScore = RankingService.clamp((preLaunchRaw / 3) * 100);
      const w = LAUNCHED_COMPOSITE_WEIGHTS;
      rawComposite = applyCompositeFloor(
        RankingService.weightedComposite([
          { score: audience.score, weight: w.audience },
          { score: rating.score, weight: w.rating },
          { score: rankQuality.score, weight: w.rankQuality },
          { score: launchBoard.score, weight: w.launchBoard },
          { score: preLaunchScore, weight: w.preLaunch },
        ]),
      );
    } else {
      const w = RESERVE_COMPOSITE_WEIGHTS;
      rawComposite = applyCompositeFloor(
        RankingService.weightedComposite([
          { score: audience.score, weight: w.audience },
          { score: rating.score, weight: w.rating },
          { score: rankQuality.score, weight: w.rankQuality },
        ]),
      );
    }

    const compositeScore = RankingService.clamp(rawComposite, 0, 100);
    const R = RankingService.r1;
    const preLaunchScoreOut =
      segment === "launched" ? R(RankingService.clamp((preLaunchRaw / 3) * 100)) : undefined;

    const audienceBlock = {
      score: R(audience.score),
      metric: audience.metric,
      start: audience.start,
      end: audience.end,
      delta: audience.delta,
      baseValue: R(audience.baseValue),
      baseTierLabel: audience.baseTierLabel,
      growthBonus: R(audience.growthBonus),
      growthTierLabel: audience.growthTierLabel,
      growthWeight: audience.growthWeight,
    };

    const detail: GamePotentialDetail = {
      audience: audienceBlock,
      scale: audienceBlock,
      growth: audienceBlock,
      rating: {
        score: rating.score != null ? R(rating.score) : 0,
        start: rating.start,
        end: rating.end,
        delta: rating.delta,
        baseValue: rating.baseValue,
        deltaAdjustment: rating.deltaAdjustment,
      },
      rankQuality: {
        score: R(rankQuality.score),
        positionQuality: rankQuality.positionQuality,
        top10Rate: rankQuality.top10Rate,
        top20Rate: rankQuality.top20Rate,
        top50Rate: rankQuality.top50Rate,
        presenceScore: rankQuality.presenceScore,
        streakScore: rankQuality.streakScore,
        volatilityScore: rankQuality.volatilityScore,
        movementScore: rankQuality.movementScore,
        avgRank: rankQuality.avgRank,
        bestRank: rankQuality.bestRank,
        rankStart: rankQuality.rankStart,
        rankEnd: rankQuality.rankEnd,
        change: rankQuality.change,
        stdDev: rankQuality.stdDev,
        longestTop20Streak: rankQuality.longestTop20Streak,
        daysTracked: rankQuality.daysTracked,
      },
      confidence,
      compositeScore: R(compositeScore),
      rawComposite: R(rawComposite),
      floorApplied,
      segment,
      preLaunchBonus: segment === "launched" ? R(preLaunchRaw) : undefined,
      preLaunchScore: preLaunchScoreOut,
      launchBoard,
    };

    return { detail, validRows };
  }

  private scoreAppRows(
    appId: number,
    appRows: AppRankRow[],
    days: number,
    platform: "combined" | "android" | "ios",
    segment: PotentialSegment,
  ): PotentialScoreResult | null {
    const computed = this.computePillars(appRows, days, platform, segment);
    if (!computed) return null;
    const { detail, validRows } = computed;
    const latest = validRows[validRows.length - 1]!;
    const R = RankingService.r1;

    const firstRank = detail.rankQuality.rankStart;
    const lastRank = detail.rankQuality.rankEnd;
    const threshold = Math.max(2, Math.ceil(detail.rankQuality.daysTracked * 0.15));
    const trend: "up" | "down" | "stable" =
      lastRank < firstRank - threshold ? "up" : lastRank > firstRank + threshold ? "down" : "stable";

    const audienceDelta =
      detail.audience.start != null && detail.audience.end != null ? detail.audience.delta : null;
    const audienceGrowthRate =
      audienceDelta != null && detail.audience.start != null && detail.audience.start > 0
        ? R((audienceDelta / detail.audience.start) * 1000) / 10
        : null;

    const out: PotentialScoreResult = {
      appId,
      title: latest.title ?? `App #${appId}`,
      iconUrl: latest.iconUrl ?? null,
      audienceScore: detail.audience.score,
      scaleScore: detail.audience.score,
      growthScore: detail.audience.score,
      ratingScore: detail.rating.score,
      rankQualityScore: detail.rankQuality.score,
      launchBoardScore: detail.launchBoard ? detail.launchBoard.score : undefined,
      dataConfidence: R(detail.confidence.coverage),
      compositeScore: detail.compositeScore,
      currentRank: lastRank,
      androidRank: latest.reserveAndroidRank,
      iosRank: latest.reserveIosRank,
      hotAndroidRank: latest.hotAndroidRank,
      hotIosRank: latest.hotIosRank,
      popAndroidRank: latest.popAndroidRank,
      popIosRank: latest.popIosRank,
      newAndroidRank: latest.newAndroidRank,
      newIosRank: latest.newIosRank,
      rating: latest.rating ?? null,
      fansCount: latest.fansCount ?? null,
      trend,
      segment,
      audienceGrowthAbsolute: audienceDelta,
      audienceGrowthRate,
      momentumMovementScore: R(detail.rankQuality.movementScore),
    };

    if (segment === "launched") {
      out.launchCategory = this.launchCategoryForApp(appRows);
      out.primaryLaunchBoard = primaryLaunchBoard(latest, platform);
      out.launchBoardTags = activeLaunchBoards(latest, platform);
      out.downloadCount = this.downloadCountForRow(latest);
      const relOut = releaseDateFromRaw(latest.raw);
      if (relOut) out.releaseDate = relOut.toISOString().split("T")[0];
    }

    return out;
  }

  private buildGamePotentialDetailFromRows(
    appRows: AppRankRow[],
    days: number,
    platform: "combined" | "android" | "ios",
    segment: PotentialSegment,
    listEntry?: PotentialScoreResult,
  ): GamePotentialDetail | null {
    if (appRows.length < 2) return null;
    const computed = this.computePillars(appRows, days, platform, segment);
    if (!computed) return null;
    return this.enrichGamePotentialDetail(computed.detail, days, platform, segment, listEntry);
  }

  private enrichGamePotentialDetail(
    detail: GamePotentialDetail,
    days: number,
    platform: "combined" | "android" | "ios",
    segment: PotentialSegment,
    listEntry?: PotentialScoreResult,
  ): GamePotentialDetail {
    const R = RankingService.r1;
    const aud = detail.audience;
    const audienceDelta = aud.start != null && aud.end != null ? aud.delta : null;
    const audienceGrowthRate =
      audienceDelta != null && aud.start != null && aud.start > 0
        ? R((audienceDelta / aud.start) * 1000) / 10
        : null;
    const momentum = this.momentumFieldsFromListEntry(listEntry, detail, days, platform, segment);
    return {
      ...detail,
      audienceGrowthAbsolute: audienceDelta,
      audienceGrowthRate,
      ...momentum,
    };
  }

  private findPotentialRanks(
    appId: number,
    list: PotentialScoreResult[],
  ): { growth: number | null; stable: number | null; total: number } {
    if (list.length === 0) return { growth: null, stable: null, total: 0 };
    const growthSorted = [...list].sort(
      (a, b) => (b.momentumScore ?? -Infinity) - (a.momentumScore ?? -Infinity),
    );
    const stableSorted = [...list].sort((a, b) => b.compositeScore - a.compositeScore);
    const gi = growthSorted.findIndex((s) => s.appId === appId);
    const si = stableSorted.findIndex((s) => s.appId === appId);
    return {
      growth: gi >= 0 ? gi + 1 : null,
      stable: si >= 0 ? si + 1 : null,
      total: list.length,
    };
  }

  private attachPotentialRanks(
    detail: GamePotentialDetail | null,
    ranks: { growth: number | null; stable: number | null; total: number },
    listEntry?: PotentialScoreResult,
  ): GamePotentialDetail | null {
    if (!detail) return null;
    const momentumFromList =
      listEntry?.momentumScore != null
        ? {
            momentumScore: listEntry.momentumScore,
            momentumGrowthNorm: listEntry.momentumGrowthNorm,
            momentumGrowthPercentile: listEntry.momentumGrowthPercentile,
            momentumGrowthAbsCap: listEntry.momentumGrowthAbsCap,
            momentumGrowthCohortSize: listEntry.momentumGrowthCohortSize,
            momentumGrowthPerDayAnchors: listEntry.momentumGrowthPerDayAnchors,
            momentumMovementScore: listEntry.momentumMovementScore,
          }
        : {};
    return {
      ...detail,
      ...momentumFromList,
      potentialRankGrowth: ranks.growth,
      potentialRankStable: ranks.stable,
      potentialListSize: ranks.total,
    };
  }

  async getGamePotentialDetail(
    appId: number,
    days: number = 14,
    platform: "combined" | "android" | "ios" = "combined",
    segment: PotentialSegment = "reserve",
  ) {
    const firstLaunch = segment === "reserve" ? await this.fetchFirstLaunchDate(appId) : null;
    const launchKey = firstLaunch ? firstLaunch.toISOString().split("T")[0] : "rolling";
    return getCachedOrFetch(
      `potential-detail-${this.algoVersion(segment)}-${segment}-${appId}-${platform}-${days}-${launchKey}`,
      async () => {
        await ensurePotentialScorers();
        await this.ensureGrowthCalibration(platform);
        const appRows = await this.resolveAppRowsForScoring(appId, days, segment);
        return this.buildGamePotentialDetailFromRows(appRows, days, platform, segment);
      },
    );
  }

  async getGamePotentialBreakdown(
    appId: number,
    days: number = 14,
    platform: "combined" | "android" | "ios" = "combined",
  ): Promise<PotentialBreakdown> {
    const firstLaunch = await this.fetchFirstLaunchDate(appId);
    const launchKey = firstLaunch ? firstLaunch.toISOString().split("T")[0] : "none";
    return getCachedOrFetch(
      `potential-breakdown-${BREAKDOWN_VERSION}-${appId}-${platform}-${days}-${launchKey}`,
      async () => {
        await ensurePotentialScorers();
        await this.ensureGrowthCalibration(platform);
        const recentRows = await this.fetchLightRows(days);
        const recentApp = recentRows.filter((r) => r.appId === appId);
        const lifecycle: AppLifecycleMeta = {
          ...computeAppLifecycle(recentApp),
          reserveWindowDays: days,
          reserveWindowEnd: launchKey !== "none" ? launchKey : null,
        };
        const reserveRows = await this.resolveAppRowsForScoring(appId, days, "reserve");
        const launchRows = await this.resolveAppRowsForScoring(appId, days, "launched");
        const [reserveList, launchedList] = await Promise.all([
          this.calculatePotentialScores(days, platform, "reserve"),
          this.calculatePotentialScores(days, platform, "launched"),
        ]);
        const reserveEntry = reserveList.find((s) => s.appId === appId);
        const launchedEntry = launchedList.find((s) => s.appId === appId);
        const reserveRanks = this.findPotentialRanks(appId, reserveList);
        const launchedRanks = this.findPotentialRanks(appId, launchedList);
        return {
          lifecycle,
          reserve: this.attachPotentialRanks(
            this.buildGamePotentialDetailFromRows(
              reserveRows,
              days,
              platform,
              "reserve",
              reserveEntry,
            ),
            reserveRanks,
            reserveEntry,
          ),
          launched: this.attachPotentialRanks(
            this.buildGamePotentialDetailFromRows(
              launchRows,
              days,
              platform,
              "launched",
              launchedEntry,
            ),
            launchedRanks,
            launchedEntry,
          ),
        };
      },
    );
  }

  private async fetchLightRows(days: number): Promise<AppRankRow[]> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const { rows } = await pool.query<AppRankRow>(APP_RANK_LIGHT_SELECT_SQL, [cutoff]);
    return rows;
  }

  async calculatePotentialScores(
    days: number = 14,
    platform: "combined" | "android" | "ios" = "android",
    segment: PotentialSegment = "reserve",
  ): Promise<PotentialScoreResult[]> {
    return getCachedOrFetch(
      `potential-${this.algoVersion(segment)}-${segment}-${platform}-${days}`,
      async () => {
        await ensurePotentialScorers();
        await this.ensureGrowthCalibration(platform);
        const rows = await this.fetchLightRows(days);

        const grouped = new Map<number, AppRankRow[]>();
        for (const row of rows) {
          if (!grouped.has(row.appId)) grouped.set(row.appId, []);
          grouped.get(row.appId)!.push(row);
        }

        const results: PotentialScoreResult[] = [];
        for (const [appId, appRows] of grouped) {
          if (segment === "reserve" && !this.isReserveOnlyApp(appRows)) continue;
          if (segment === "launched" && !this.isLaunchedApp(appRows)) continue;

          const scored = this.scoreAppRows(appId, appRows, days, platform, segment);
          if (scored) results.push(scored);
        }

        const withMomentum = this.applyGrowthMomentumPostPass(results, days, platform, segment);
        withMomentum.sort((a, b) => b.compositeScore - a.compositeScore);
        return withMomentum;
      },
    );
  }

  async getTopReserveGrowth(
    days: number = 14,
    platform: "combined" | "android" | "ios" = "combined",
  ) {
    return getCachedOrFetch(
      `reserve-growth-${ALGO_VERSION_RESERVE}-${platform}-${days}`,
      async () => {
        const rows = await this.fetchLightRows(days);

        const grouped = new Map<number, AppRankRow[]>();
        for (const row of rows) {
          if (!grouped.has(row.appId)) grouped.set(row.appId, []);
          grouped.get(row.appId)!.push(row);
        }

        return Array.from(grouped.entries())
          .map(([appId, appRows]) => {
            const valid = appRows.filter(
              (r) =>
                reserveRank(r, platform) != null &&
                r.reserveCount != null &&
                r.reserveCount > 0,
            );
            if (valid.length < 2) return null;

            const first = valid[0].reserveCount!;
            const last = valid[valid.length - 1].reserveCount!;
            const growth = last - first;
            if (growth <= 0) return null;

            const latest = valid[valid.length - 1]!;
            return {
              appId,
              title: latest.title ?? `App #${appId}`,
              iconUrl: latest.iconUrl ?? null,
              startReserve: first,
              currentReserve: last,
              growth,
              growthRate: Math.round((growth / first) * 1000) / 10,
              currentRank: reserveRank(latest, platform),
              daysTracked: valid.length,
            };
          })
          .filter((g): g is NonNullable<typeof g> => g != null)
          .sort((a, b) => b.growth - a.growth)
          .slice(0, 30);
      },
    );
  }

  async detectBreakoutGames(
    days: number = 7,
    threshold: number = 20,
    platform: "combined" | "android" | "ios" = "android",
    segment: PotentialSegment = "reserve",
  ) {
    return getCachedOrFetch(
      `breakout-${this.algoVersion(segment)}-${segment}-${platform}-${days}-${threshold}`,
      async () => {
        const rows = await this.fetchLightRows(days);

        const grouped = new Map<number, AppRankRow[]>();
        for (const row of rows) {
          if (!grouped.has(row.appId)) grouped.set(row.appId, []);
          grouped.get(row.appId)!.push(row);
        }

        const getRank = (r: AppRankRow) => this.getRankForSegment(r, segment, platform);

        return Array.from(grouped.entries())
          .map(([appId, appRows]) => {
            if (segment === "reserve" && !this.isReserveOnlyApp(appRows)) return null;
            if (segment === "launched" && !this.isLaunchedApp(appRows)) return null;

            const valid = appRows.filter((r) => getRank(r) != null);
            if (valid.length < 2) return null;
            const ranks = valid.map((r) => getRank(r)!);
            const improvement = ranks[0] - ranks[ranks.length - 1];
            const latest = valid[valid.length - 1]!;
            return {
              appId,
              title: latest.title ?? `App #${appId}`,
              iconUrl: latest.iconUrl ?? null,
              startRank: ranks[0],
              currentRank: ranks[ranks.length - 1],
              improvement,
              daysTracked: ranks.length,
            };
          })
          .filter(
            (g): g is NonNullable<typeof g> => g != null && g.improvement >= threshold,
          )
          .sort((a, b) => b.improvement - a.improvement);
      },
    );
  }
}

export const rankingService = new RankingService();
