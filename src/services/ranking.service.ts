import { pool } from "../utils/prisma";
import { getCachedOrFetch } from "../utils/cache";
import type { PotentialScoreResult } from "../types";
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
  launchBoardCount,
  launchedPriorityRank,
  primaryLaunchBoard,
  releaseDateFromRaw,
  reserveRank,
  type AppLifecycleMeta,
} from "../utils/app-rank";
import type { GamePotentialDetail, PotentialBreakdown } from "../types";
import { downloadCountFromRaw } from "../utils/taptap-raw-extract";

const ALGO_VERSION_RESERVE = "v6";
const ALGO_VERSION_LAUNCHED = "v8";

export class RankingService {
  private static clamp(v: number, lo = 0, hi = 100) {
    return Math.max(lo, Math.min(hi, v));
  }

  private static r1(v: number) {
    return Math.round(v * 10) / 10;
  }

  private scoreMomentum(ranks: number[]) {
    const C = RankingService.clamp;
    const R = RankingService.r1;

    const recentHalf = ranks.slice(Math.floor(ranks.length / 2));
    const avgRecentRank = recentHalf.reduce((a, b) => a + b, 0) / recentHalf.length;
    const positionScore = C(100 - avgRecentRank * 0.5);

    const rankStart = ranks[0];
    const rankEnd = ranks[ranks.length - 1];
    const change = rankStart - rankEnd;
    const absoluteScore = C(50 + change);
    const maxClimb = Math.max(rankStart - 1, 1);
    const relativeScore = C(50 + (change / maxClimb) * 50);
    const rankChangeScore = Math.max(absoluteScore, relativeScore);

    const bestRank = Math.min(...ranks);
    const peakScore = C(100 - bestRank * 0.5);

    const score = positionScore * 0.5 + rankChangeScore * 0.25 + peakScore * 0.25;
    return {
      score,
      positionScore,
      avgRecentRank: R(avgRecentRank),
      rankChangeScore,
      absoluteScore,
      relativeScore,
      peakScore,
      bestRank,
      rankStart,
      rankEnd,
      change,
    };
  }

  private static absThreshold(days: number): number {
    if (days <= 7) return 50_000;
    if (days <= 14) return 100_000;
    return 200_000;
  }

  private scoreEngagement(
    ratings: (string | null)[],
    fansCounts: (number | null)[],
    reserveCounts: (number | null)[],
    days: number = 14,
    opts?: { includeReserve?: boolean; downloadCounts?: (number | null)[] },
  ) {
    const includeReserve = opts?.includeReserve !== false;
    const downloadCounts = opts?.downloadCounts;
    const subs: Array<{ name: string; score: number }> = [];
    const C = RankingService.clamp;
    const T = RankingService.absThreshold(days);

    const validRatings = ratings.filter((r): r is string => r !== null).map(Number).filter((n) => !isNaN(n));
    const ratingStart = validRatings.length >= 2 ? validRatings[0] : null;
    const ratingEnd = validRatings.length >= 2 ? validRatings[validRatings.length - 1] : null;
    const ratingDelta = ratingStart != null && ratingEnd != null ? ratingEnd - ratingStart : 0;
    let ratingBaseScore: number | null = null;
    let ratingChangeScore: number | null = null;
    let ratingScore: number | null = null;
    if (ratingEnd != null) {
      ratingBaseScore = C((ratingEnd - 5) * 20);
      ratingChangeScore = ratingStart != null ? C(50 + ratingDelta * 20) : 50;
      ratingScore = ratingBaseScore * 0.6 + ratingChangeScore * 0.4;
      subs.push({ name: "rating", score: ratingScore });
    }

    const validFans = fansCounts.filter((f): f is number => f !== null && f > 0);
    const fansStart = validFans.length >= 2 ? validFans[0] : null;
    const fansEnd = validFans.length >= 2 ? validFans[validFans.length - 1] : null;
    const fansGrowth = fansStart != null && fansEnd != null ? fansEnd - fansStart : 0;
    const fansRate = fansStart != null && fansStart >= 100 ? fansGrowth / fansStart : null;
    const fansRateScore = fansRate != null ? C(fansRate * 200) : null;
    const fansAbsScore = fansGrowth > 0 ? C((fansGrowth / T) * 100) : null;
    const fansScore =
      fansRateScore != null && fansAbsScore != null
        ? Math.max(fansRateScore, fansAbsScore)
        : fansRateScore ?? fansAbsScore;
    if (fansScore != null) subs.push({ name: "fans", score: fansScore });

    let resStart: number | null = null;
    let resEnd: number | null = null;
    let resGrowth = 0;
    let resRate: number | null = null;
    let resRateScore: number | null = null;
    let resAbsScore: number | null = null;
    let resScore: number | null = null;
    if (includeReserve) {
      const validRes = reserveCounts.filter((r): r is number => r !== null && r > 0);
      resStart = validRes.length >= 2 ? validRes[0] : null;
      resEnd = validRes.length >= 2 ? validRes[validRes.length - 1] : null;
      resGrowth = resStart != null && resEnd != null ? resEnd - resStart : 0;
      resRate = resStart != null && resStart >= 50 ? resGrowth / resStart : null;
      resRateScore = resRate != null ? C(resRate * 200) : null;
      resAbsScore = resGrowth > 0 ? C((resGrowth / T) * 100) : null;
      resScore =
        resRateScore != null && resAbsScore != null
          ? Math.max(resRateScore, resAbsScore)
          : resRateScore ?? resAbsScore;
      if (resScore != null) subs.push({ name: "reserve", score: resScore });
    }

    let dlStart: number | null = null;
    let dlEnd: number | null = null;
    let dlGrowth = 0;
    let dlRate: number | null = null;
    let dlRateScore: number | null = null;
    let dlAbsScore: number | null = null;
    let dlScore: number | null = null;
    if (downloadCounts) {
      const validDl = downloadCounts.filter((d): d is number => d !== null && d > 0);
      dlStart = validDl.length >= 2 ? validDl[0] : null;
      dlEnd = validDl.length >= 2 ? validDl[validDl.length - 1] : null;
      dlGrowth = dlStart != null && dlEnd != null ? dlEnd - dlStart : 0;
      dlRate = dlStart != null && dlStart >= 1000 ? dlGrowth / dlStart : null;
      dlRateScore = dlRate != null ? C(dlRate * 200) : null;
      dlAbsScore = dlGrowth > 0 ? C((dlGrowth / T) * 100) : null;
      dlScore =
        dlRateScore != null && dlAbsScore != null
          ? Math.max(dlRateScore, dlAbsScore)
          : dlRateScore ?? dlAbsScore;
      if (dlScore != null) subs.push({ name: "download", score: dlScore });
    }

    const score = subs.length > 0 ? subs.reduce((a, s) => a + s.score, 0) / subs.length : 50;
    const R = RankingService.r1;

    return {
      score,
      ratingStart,
      ratingEnd,
      ratingDelta,
      ratingBaseScore: ratingBaseScore != null ? R(ratingBaseScore) : null,
      ratingChangeScore: ratingChangeScore != null ? R(ratingChangeScore) : null,
      ratingScore: ratingScore != null ? R(ratingScore) : null,
      fansStart,
      fansEnd,
      fansGrowth,
      fansRate: fansRate != null ? R(fansRate * 100) : null,
      fansRateScore: fansRateScore != null ? R(fansRateScore) : null,
      fansAbsScore: fansAbsScore != null ? R(fansAbsScore) : null,
      fansScore: fansScore != null ? R(fansScore) : null,
      resStart,
      resEnd,
      resGrowth,
      resRate: resRate != null ? R(resRate * 100) : null,
      resRateScore: resRateScore != null ? R(resRateScore) : null,
      resAbsScore: resAbsScore != null ? R(resAbsScore) : null,
      resScore: resScore != null ? R(resScore) : null,
      dlStart,
      dlEnd,
      dlGrowth,
      dlRate: dlRate != null ? R(dlRate * 100) : null,
      dlRateScore: dlRateScore != null ? R(dlRateScore) : null,
      dlAbsScore: dlAbsScore != null ? R(dlAbsScore) : null,
      dlScore: dlScore != null ? R(dlScore) : null,
      subsCount: subs.length,
      absThreshold: T,
    };
  }

  private scoreStability(ranks: number[], analysisDays: number, topN = 200) {
    const daysInTop = Math.min(ranks.filter((r) => r <= topN).length, analysisDays);
    const presenceScore = RankingService.clamp((daysInTop / analysisDays) * 100);

    const mean = ranks.reduce((a, b) => a + b, 0) / ranks.length;
    const variance = ranks.reduce((a, b) => a + (b - mean) ** 2, 0) / ranks.length;
    const stdDev = Math.sqrt(variance);
    const volatilityScore = RankingService.clamp(100 - stdDev * 2);

    let maxStreak = 0,
      cur = 0;
    for (const r of ranks) {
      if (r <= topN) {
        cur++;
        maxStreak = Math.max(maxStreak, cur);
      } else cur = 0;
    }
    maxStreak = Math.min(maxStreak, analysisDays);
    const streakScore = RankingService.clamp((maxStreak / analysisDays) * 100);

    const score = presenceScore * 0.5 + volatilityScore * 0.3 + streakScore * 0.2;
    return {
      score,
      presenceScore,
      volatilityScore,
      streakScore,
      daysInTop,
      stdDev: RankingService.r1(stdDev),
      maxStreak,
      analysisDays,
    };
  }

  private scoreConfidence(dataPoints: number, analysisDays: number) {
    const coverage = Math.min(dataPoints / analysisDays, 1);
    const multiplier = RankingService.clamp(coverage, 0.3, 1);
    return {
      coverage: RankingService.r1(coverage * 100),
      multiplier: Math.round(multiplier * 1000) / 1000,
      dataPoints: Math.min(dataPoints, analysisDays),
      analysisDays,
    };
  }

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

  private scoreAppRows(
    appId: number,
    appRows: AppRankRow[],
    days: number,
    platform: "combined" | "android" | "ios",
    segment: PotentialSegment,
  ): PotentialScoreResult | null {
    const getRank = (r: AppRankRow) => this.getRankForSegment(r, segment, platform);
    const rowsForScore =
      segment === "launched" ? this.slicePostLaunchRows(appRows) : appRows;
    const validRows = rowsForScore.filter((r) => getRank(r) != null);

    const rel = releaseDateFromRaw(appRows[appRows.length - 1]?.raw);
    const releaseRecent =
      rel != null && (Date.now() - rel.getTime()) / 86400000 <= 60;
    const minPoints = segment === "launched" && releaseRecent ? 2 : 3;
    if (validRows.length < minPoints) return null;

    const analysisDays = days;
    const ranks = validRows.map((r) => getRank(r)!);
    const ratings = validRows.map((r) => r.rating ?? null);
    const fans = validRows.map((r) => r.fansCount ?? null);
    const reserves = validRows.map((r) => r.reserveCount ?? null);
    const downloads = validRows.map((r) => this.downloadCountForRow(r));

    const momentum = this.scoreMomentum(ranks);
    const engagement =
      segment === "launched"
        ? this.scoreEngagement(ratings, fans, reserves, analysisDays, {
            includeReserve: false,
            downloadCounts: downloads,
          })
        : this.scoreEngagement(ratings, fans, reserves, analysisDays, { includeReserve: true });
    const stability = this.scoreStability(ranks, analysisDays);
    let confidence = this.scoreConfidence(validRows.length, analysisDays);
    if (segment === "launched" && validRows.length < 3) {
      confidence = {
        ...confidence,
        multiplier: Math.min(confidence.multiplier, 0.85),
      };
    }

    let rawComposite: number;
    if (segment === "launched") {
      rawComposite = momentum.score * 0.25 + engagement.score * 0.55 + stability.score * 0.2;
      const latestRow = validRows[validRows.length - 1]!;
      if (launchBoardCount(latestRow, platform) >= 2) rawComposite += 5;
      rawComposite += this.scorePreLaunchReserveBonus(appRows);
    } else {
      rawComposite = momentum.score * 0.2 + engagement.score * 0.6 + stability.score * 0.2;
    }
    const compositeScore = rawComposite * confidence.multiplier;

    const latest = validRows[validRows.length - 1]!;
    const firstRank = ranks[0];
    const lastRank = ranks[ranks.length - 1];
    const threshold = Math.max(2, Math.ceil(ranks.length * 0.15));
    const trend: "up" | "down" | "stable" =
      lastRank < firstRank - threshold ? "up" : lastRank > firstRank + threshold ? "down" : "stable";

    const R = RankingService.r1;
    const out: PotentialScoreResult = {
      appId,
      title: latest.title ?? `App #${appId}`,
      iconUrl: latest.iconUrl ?? null,
      momentumScore: R(momentum.score),
      engagementScore: R(engagement.score),
      stabilityScore: R(stability.score),
      dataConfidence: R(confidence.coverage),
      compositeScore: R(compositeScore),
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
  ): GamePotentialDetail | null {
    if (appRows.length < 2) return null;

    const getRank = (r: AppRankRow) => this.getRankForSegment(r, segment, platform);
    const rowsForScore =
      segment === "launched" ? this.slicePostLaunchRows(appRows) : appRows;
    const validRows = rowsForScore.filter((r) => getRank(r) != null);

    const rel = releaseDateFromRaw(appRows[appRows.length - 1]?.raw);
    const releaseRecent =
      rel != null && (Date.now() - rel.getTime()) / 86400000 <= 60;
    const minPoints = segment === "launched" && releaseRecent ? 2 : 3;
    if (validRows.length < minPoints) return null;

    const analysisDays = days;
    const ranks = validRows.map((r) => getRank(r)!);
    const ratings = validRows.map((r) => r.rating ?? null);
    const fans = validRows.map((r) => r.fansCount ?? null);
    const reserves = validRows.map((r) => r.reserveCount ?? null);
    const downloads = validRows.map((r) => this.downloadCountForRow(r));

    const momentum = this.scoreMomentum(ranks);
    const engagement =
      segment === "launched"
        ? this.scoreEngagement(ratings, fans, reserves, analysisDays, {
            includeReserve: false,
            downloadCounts: downloads,
          })
        : this.scoreEngagement(ratings, fans, reserves, analysisDays, { includeReserve: true });
    const stability = this.scoreStability(ranks, analysisDays);
    let confidence = this.scoreConfidence(validRows.length, analysisDays);

    let rawComposite: number;
    if (segment === "launched") {
      rawComposite = momentum.score * 0.25 + engagement.score * 0.55 + stability.score * 0.2;
      const latestRow = validRows[validRows.length - 1]!;
      if (launchBoardCount(latestRow, platform) >= 2) rawComposite += 5;
      rawComposite += this.scorePreLaunchReserveBonus(appRows);
      if (validRows.length < 3) {
        confidence = { ...confidence, multiplier: Math.min(confidence.multiplier, 0.85) };
      }
    } else {
      rawComposite = momentum.score * 0.2 + engagement.score * 0.6 + stability.score * 0.2;
    }
    const compositeScore = rawComposite * confidence.multiplier;

    const R = RankingService.r1;
    return {
      momentum: {
        score: R(momentum.score),
        positionScore: R(momentum.positionScore),
        avgRecentRank: momentum.avgRecentRank,
        rankChangeScore: R(momentum.rankChangeScore),
        absoluteScore: R(momentum.absoluteScore),
        relativeScore: R(momentum.relativeScore),
        peakScore: R(momentum.peakScore),
        bestRank: momentum.bestRank,
        rankStart: momentum.rankStart,
        rankEnd: momentum.rankEnd,
        change: momentum.change,
      },
      engagement: {
        score: R(engagement.score),
        ratingStart: engagement.ratingStart,
        ratingEnd: engagement.ratingEnd,
        ratingDelta: R(engagement.ratingDelta),
        ratingBaseScore: engagement.ratingBaseScore,
        ratingChangeScore: engagement.ratingChangeScore,
        ratingScore: engagement.ratingScore,
        fansStart: engagement.fansStart,
        fansEnd: engagement.fansEnd,
        fansGrowth: engagement.fansGrowth,
        fansRate: engagement.fansRate,
        fansRateScore: engagement.fansRateScore,
        fansAbsScore: engagement.fansAbsScore,
        fansScore: engagement.fansScore,
        resStart: engagement.resStart,
        resEnd: engagement.resEnd,
        resGrowth: engagement.resGrowth,
        resRate: engagement.resRate,
        resRateScore: engagement.resRateScore,
        resAbsScore: engagement.resAbsScore,
        resScore: engagement.resScore,
        dlStart: engagement.dlStart,
        dlEnd: engagement.dlEnd,
        dlGrowth: engagement.dlGrowth,
        dlRate: engagement.dlRate,
        dlRateScore: engagement.dlRateScore,
        dlAbsScore: engagement.dlAbsScore,
        dlScore: engagement.dlScore,
        subsCount: engagement.subsCount,
        absThreshold: engagement.absThreshold,
      },
      stability: {
        score: R(stability.score),
        presenceScore: R(stability.presenceScore),
        volatilityScore: R(stability.volatilityScore),
        streakScore: R(stability.streakScore),
        daysInTop: stability.daysInTop,
        stdDev: stability.stdDev,
        maxStreak: stability.maxStreak,
        analysisDays: stability.analysisDays,
      },
      confidence,
      compositeScore: R(compositeScore),
      rawComposite: R(rawComposite),
      segment,
      preLaunchBonus:
        segment === "launched" ? R(this.scorePreLaunchReserveBonus(appRows)) : undefined,
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
      `potential-breakdown-v2-${appId}-${platform}-${days}-${launchKey}`,
      async () => {
        const recentRows = await this.fetchLightRows(days);
        const recentApp = recentRows.filter((r) => r.appId === appId);
        const lifecycle: AppLifecycleMeta = {
          ...computeAppLifecycle(recentApp),
          reserveWindowDays: days,
          reserveWindowEnd: launchKey !== "none" ? launchKey : null,
        };
        const reserveRows = await this.resolveAppRowsForScoring(appId, days, "reserve");
        const launchRows = await this.resolveAppRowsForScoring(appId, days, "launched");
        return {
          lifecycle,
          reserve: this.buildGamePotentialDetailFromRows(reserveRows, days, platform, "reserve"),
          launched: this.buildGamePotentialDetailFromRows(launchRows, days, platform, "launched"),
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

        results.sort((a, b) => b.compositeScore - a.compositeScore);
        return results;
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
