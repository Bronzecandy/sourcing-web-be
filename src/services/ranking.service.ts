import { pool } from "../utils/prisma";
import { getCachedOrFetch } from "../utils/cache";
import type { PotentialScoreResult } from "../types";

const ALGO_VERSION = "v5";

interface LightRankRow {
  appId: number;
  date: Date;
  androidRank: number | null;
  iosRank: number | null;
  title: string;
  iconUrl: string | null;
  rating: string | null;
  fansCount: number | null;
  reserveCount: number | null;
}

const LIGHT_RANK_SQL = `
  SELECT
    "appId",
    "date",
    "androidRank",
    "iosRank",
    raw->>'title' AS title,
    raw->'icon'->>'url' AS "iconUrl",
    raw->'stat'->'rating'->>'score' AS rating,
    (raw->'stat'->>'fans_count')::int AS "fansCount",
    (raw->'stat'->>'reserve_count')::int AS "reserveCount"
  FROM "AppRank"
  WHERE "date" >= $1
  ORDER BY "date" ASC
`;

export class RankingService {
  private static clamp(v: number, lo = 0, hi = 100) {
    return Math.max(lo, Math.min(hi, v));
  }

  private static r1(v: number) { return Math.round(v * 10) / 10; }

  // ─── Momentum (0-100) ───
  // 3 sub-metrics:
  //   Position (50%): 100 - avgRecentRank × 0.5, bounded 0-100
  //   Rank Change (25%): max(absoluteScore, relativeScore)
  //   Peak Performance (25%): 100 - bestRank × 0.5, bounded 0-100
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
      score, positionScore, avgRecentRank: R(avgRecentRank),
      rankChangeScore, absoluteScore, relativeScore,
      peakScore, bestRank,
      rankStart, rankEnd, change,
    };
  }

  // ─── Engagement (0-100) ───
  // rating: baseScore (60%) from absolute level + changeScore (40%) from improvement
  // fans/reserve: max(rateScore, absoluteScore) — threshold scales with period
  //   7d → 50k, 14d → 100k, 30d → 200k
  // score = average of available sub-metrics
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
  ) {
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
    const fansScore = fansRateScore != null && fansAbsScore != null
      ? Math.max(fansRateScore, fansAbsScore)
      : fansRateScore ?? fansAbsScore;
    if (fansScore != null) subs.push({ name: "fans", score: fansScore });

    const validRes = reserveCounts.filter((r): r is number => r !== null && r > 0);
    const resStart = validRes.length >= 2 ? validRes[0] : null;
    const resEnd = validRes.length >= 2 ? validRes[validRes.length - 1] : null;
    const resGrowth = resStart != null && resEnd != null ? resEnd - resStart : 0;
    const resRate = resStart != null && resStart >= 50 ? resGrowth / resStart : null;
    const resRateScore = resRate != null ? C(resRate * 200) : null;
    const resAbsScore = resGrowth > 0 ? C((resGrowth / T) * 100) : null;
    const resScore = resRateScore != null && resAbsScore != null
      ? Math.max(resRateScore, resAbsScore)
      : resRateScore ?? resAbsScore;
    if (resScore != null) subs.push({ name: "reserve", score: resScore });

    const score = subs.length > 0 ? subs.reduce((a, s) => a + s.score, 0) / subs.length : 50;
    const R = RankingService.r1;

    return {
      score,
      ratingStart, ratingEnd, ratingDelta,
      ratingBaseScore: ratingBaseScore != null ? R(ratingBaseScore) : null,
      ratingChangeScore: ratingChangeScore != null ? R(ratingChangeScore) : null,
      ratingScore: ratingScore != null ? R(ratingScore) : null,
      fansStart, fansEnd, fansGrowth,
      fansRate: fansRate != null ? R(fansRate * 100) : null,
      fansRateScore: fansRateScore != null ? R(fansRateScore) : null,
      fansAbsScore: fansAbsScore != null ? R(fansAbsScore) : null,
      fansScore: fansScore != null ? R(fansScore) : null,
      resStart, resEnd, resGrowth,
      resRate: resRate != null ? R(resRate * 100) : null,
      resRateScore: resRateScore != null ? R(resRateScore) : null,
      resAbsScore: resAbsScore != null ? R(resAbsScore) : null,
      resScore: resScore != null ? R(resScore) : null,
      subsCount: subs.length,
      absThreshold: T,
    };
  }

  // ─── Stability (0-100) ───
  // presence (50%): (daysInTop200 / analysisDays) × 100
  // volatility (30%): clamp(100 - stdDev × 2, 0, 100)
  // streak (20%): (maxStreak / analysisDays) × 100
  private scoreStability(ranks: number[], analysisDays: number, topN = 200) {
    const daysInTop = Math.min(ranks.filter((r) => r <= topN).length, analysisDays);
    const presenceScore = RankingService.clamp((daysInTop / analysisDays) * 100);

    const mean = ranks.reduce((a, b) => a + b, 0) / ranks.length;
    const variance = ranks.reduce((a, b) => a + (b - mean) ** 2, 0) / ranks.length;
    const stdDev = Math.sqrt(variance);
    const volatilityScore = RankingService.clamp(100 - stdDev * 2);

    let maxStreak = 0, cur = 0;
    for (const r of ranks) { if (r <= topN) { cur++; maxStreak = Math.max(maxStreak, cur); } else cur = 0; }
    maxStreak = Math.min(maxStreak, analysisDays);
    const streakScore = RankingService.clamp((maxStreak / analysisDays) * 100);

    const score = presenceScore * 0.5 + volatilityScore * 0.3 + streakScore * 0.2;
    return { score, presenceScore, volatilityScore, streakScore, daysInTop, stdDev: RankingService.r1(stdDev), maxStreak, analysisDays };
  }

  // ─── Confidence (multiplier 0.3-1.0) ───
  // multiplier = clamp(coverage, 0.3, 1.0) where coverage = min(dataPoints/analysisDays, 1)
  private scoreConfidence(dataPoints: number, analysisDays: number) {
    const coverage = Math.min(dataPoints / analysisDays, 1);
    const multiplier = RankingService.clamp(coverage, 0.3, 1);
    return { coverage: RankingService.r1(coverage * 100), multiplier: Math.round(multiplier * 1000) / 1000, dataPoints: Math.min(dataPoints, analysisDays), analysisDays };
  }

  // ─── Game Potential Detail (for game detail page) ───
  async getGamePotentialDetail(appId: number, days: number = 14, platform: "combined" | "android" | "ios" = "combined") {
    return getCachedOrFetch(
      `potential-detail-${ALGO_VERSION}-${appId}-${platform}-${days}`,
      async () => {
        const rows = await this.fetchLightRows(days);
        const appRows = rows.filter((r) => r.appId === appId);

        const getRank = (r: LightRankRow): number | null =>
          platform === "combined" ? this.bestRank(r) : r[platform === "android" ? "androidRank" : "iosRank"];

        const validRows = appRows.filter((r) => getRank(r) != null);
        if (validRows.length < 2) return null;

        const ranks = validRows.map((r) => getRank(r)!);
        const ratings = validRows.map((r) => r.rating);
        const fans = validRows.map((r) => r.fansCount);
        const reserves = validRows.map((r) => r.reserveCount);

        const momentum = this.scoreMomentum(ranks);
        const engagement = this.scoreEngagement(ratings, fans, reserves, days);
        const stability = this.scoreStability(ranks, days);
        const confidence = this.scoreConfidence(validRows.length, days);

        const rawComposite = momentum.score * 0.20 + engagement.score * 0.60 + stability.score * 0.20;
        const compositeScore = rawComposite * confidence.multiplier;

        const R = RankingService.r1;
        return {
          momentum: {
            score: R(momentum.score),
            positionScore: R(momentum.positionScore), avgRecentRank: momentum.avgRecentRank,
            rankChangeScore: R(momentum.rankChangeScore), absoluteScore: R(momentum.absoluteScore), relativeScore: R(momentum.relativeScore),
            peakScore: R(momentum.peakScore), bestRank: momentum.bestRank,
            rankStart: momentum.rankStart, rankEnd: momentum.rankEnd, change: momentum.change,
          },
          engagement: {
            score: R(engagement.score),
            ratingStart: engagement.ratingStart, ratingEnd: engagement.ratingEnd, ratingDelta: R(engagement.ratingDelta),
            ratingBaseScore: engagement.ratingBaseScore, ratingChangeScore: engagement.ratingChangeScore, ratingScore: engagement.ratingScore,
            fansStart: engagement.fansStart, fansEnd: engagement.fansEnd, fansGrowth: engagement.fansGrowth,
            fansRate: engagement.fansRate, fansRateScore: engagement.fansRateScore, fansAbsScore: engagement.fansAbsScore, fansScore: engagement.fansScore,
            resStart: engagement.resStart, resEnd: engagement.resEnd, resGrowth: engagement.resGrowth,
            resRate: engagement.resRate, resRateScore: engagement.resRateScore, resAbsScore: engagement.resAbsScore, resScore: engagement.resScore,
            subsCount: engagement.subsCount, absThreshold: engagement.absThreshold,
          },
          stability: { score: R(stability.score), presenceScore: R(stability.presenceScore), volatilityScore: R(stability.volatilityScore), streakScore: R(stability.streakScore), daysInTop: stability.daysInTop, stdDev: stability.stdDev, maxStreak: stability.maxStreak, analysisDays: stability.analysisDays },
          confidence,
          compositeScore: R(compositeScore),
          rawComposite: R(rawComposite),
        };
      }
    );
  }

  private async fetchLightRows(days: number): Promise<LightRankRow[]> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const { rows } = await pool.query<LightRankRow>(LIGHT_RANK_SQL, [cutoff]);
    return rows;
  }

  private bestRank(row: LightRankRow): number | null {
    const a = row.androidRank;
    const b = row.iosRank;
    if (a != null && b != null) return Math.min(a, b);
    return a ?? b;
  }

  async calculatePotentialScores(
    days: number = 14,
    platform: "combined" | "android" | "ios" = "android"
  ): Promise<PotentialScoreResult[]> {
    return getCachedOrFetch(
      `potential-${ALGO_VERSION}-${platform}-${days}`,
      async () => {
        const rows = await this.fetchLightRows(days);

        const grouped = new Map<number, LightRankRow[]>();
        for (const row of rows) {
          if (!grouped.has(row.appId)) grouped.set(row.appId, []);
          grouped.get(row.appId)!.push(row);
        }

        const results: PotentialScoreResult[] = [];
        const MIN_DATA_POINTS = 3;

        const getRank = (r: LightRankRow): number | null =>
          platform === "combined"
            ? this.bestRank(r)
            : r[platform === "android" ? "androidRank" : "iosRank"];

        const R = RankingService.r1;
        for (const [appId, appRows] of grouped) {
          const validRows = appRows.filter((r) => getRank(r) != null);
          if (validRows.length < MIN_DATA_POINTS) continue;

          const ranks = validRows.map((r) => getRank(r)!);
          const ratings = validRows.map((r) => r.rating);
          const fans = validRows.map((r) => r.fansCount);
          const reserves = validRows.map((r) => r.reserveCount);

          const momentum = this.scoreMomentum(ranks);
          const engagement = this.scoreEngagement(ratings, fans, reserves, days);
          const stability = this.scoreStability(ranks, days);
          const confidence = this.scoreConfidence(validRows.length, days);

          const rawComposite =
            momentum.score * 0.20 +
            engagement.score * 0.60 +
            stability.score * 0.20;

          const compositeScore = rawComposite * confidence.multiplier;

          const latest = validRows[validRows.length - 1];
          const firstRank = ranks[0];
          const lastRank = ranks[ranks.length - 1];
          const threshold = Math.max(2, Math.ceil(ranks.length * 0.15));
          const trend: "up" | "down" | "stable" =
            lastRank < firstRank - threshold
              ? "up"
              : lastRank > firstRank + threshold
                ? "down"
                : "stable";

          results.push({
            appId,
            title: latest.title ?? `App #${appId}`,
            iconUrl: latest.iconUrl,
            momentumScore: R(momentum.score),
            engagementScore: R(engagement.score),
            stabilityScore: R(stability.score),
            dataConfidence: R(confidence.coverage),
            compositeScore: R(compositeScore),
            currentRank: lastRank,
            androidRank: latest.androidRank,
            iosRank: latest.iosRank,
            rating: latest.rating,
            fansCount: latest.fansCount,
            trend,
          });
        }

        results.sort((a, b) => b.compositeScore - a.compositeScore);
        return results;
      }
    );
  }

  async getTopReserveGrowth(
    days: number = 14,
    platform: "combined" | "android" | "ios" = "combined"
  ) {
    return getCachedOrFetch(
      `reserve-growth-${ALGO_VERSION}-${platform}-${days}`,
      async () => {
        const rows = await this.fetchLightRows(days);

        const grouped = new Map<number, LightRankRow[]>();
        for (const row of rows) {
          if (!grouped.has(row.appId)) grouped.set(row.appId, []);
          grouped.get(row.appId)!.push(row);
        }

        const getRank = (r: LightRankRow): number | null =>
          platform === "combined"
            ? this.bestRank(r)
            : r[platform === "android" ? "androidRank" : "iosRank"];

        return Array.from(grouped.entries())
          .map(([appId, appRows]) => {
            const valid = appRows.filter(
              (r) => getRank(r) != null && r.reserveCount != null && r.reserveCount > 0
            );
            if (valid.length < 2) return null;

            const first = valid[0].reserveCount!;
            const last = valid[valid.length - 1].reserveCount!;
            const growth = last - first;
            if (growth <= 0) return null;

            const latest = valid[valid.length - 1];
            return {
              appId,
              title: latest.title ?? `App #${appId}`,
              iconUrl: latest.iconUrl,
              startReserve: first,
              currentReserve: last,
              growth,
              growthRate: Math.round((growth / first) * 1000) / 10,
              currentRank: getRank(latest),
              daysTracked: valid.length,
            };
          })
          .filter((g): g is NonNullable<typeof g> => g !== null)
          .sort((a, b) => b.growth - a.growth)
          .slice(0, 30);
      }
    );
  }

  async detectBreakoutGames(
    days: number = 7,
    threshold: number = 20,
    platform: "combined" | "android" | "ios" = "android"
  ) {
    return getCachedOrFetch(
      `breakout-${ALGO_VERSION}-${platform}-${days}-${threshold}`,
      async () => {
        const rows = await this.fetchLightRows(days);

        const grouped = new Map<number, LightRankRow[]>();
        for (const row of rows) {
          if (!grouped.has(row.appId)) grouped.set(row.appId, []);
          grouped.get(row.appId)!.push(row);
        }

        const getRank = (r: LightRankRow): number | null =>
          platform === "combined"
            ? this.bestRank(r)
            : r[platform === "android" ? "androidRank" : "iosRank"];

        return Array.from(grouped.entries())
          .map(([appId, appRows]) => {
            const valid = appRows.filter((r) => getRank(r) != null);
            if (valid.length < 2) return null;
            const ranks = valid.map((r) => getRank(r)!);
            const improvement = ranks[0] - ranks[ranks.length - 1];
            const latest = valid[valid.length - 1];
            return {
              appId,
              title: latest.title ?? `App #${appId}`,
              iconUrl: latest.iconUrl,
              startRank: ranks[0],
              currentRank: ranks[ranks.length - 1],
              improvement,
              daysTracked: ranks.length,
            };
          })
          .filter(
            (g): g is NonNullable<typeof g> =>
              g !== null && g.improvement >= threshold
          )
          .sort((a, b) => b.improvement - a.improvement);
      }
    );
  }
}

export const rankingService = new RankingService();
