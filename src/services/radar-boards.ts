import { rankingService } from "./ranking.service";
import {
  POTENTIAL_TOP20_DAYS,
  POTENTIAL_TOP20_LIMIT,
  POTENTIAL_TOP20_PLATFORM,
  sortValue,
  storedScore,
} from "./potential-top20-alert.service";
import type { PotentialScoreResult } from "../types";
import type { RadarBoardId, RadarGameFacts, RadarMetrics } from "./radar-types";

/** Lấy dư ứng viên New Launch để còn đủ 20 sau khi loại game cũ theo ngày ra mắt trên TapTap. */
const NEW_LAUNCH_CANDIDATES = 40;

export interface RadarBoardEntry {
  board: RadarBoardId;
  rank: number;
  appId: number;
  title: string;
  score: number;
  metrics: RadarMetrics;
}

export function newLaunchMaxAgeDays(): number {
  const n = Number(process.env.RADAR_NEW_LAUNCH_MAX_AGE_DAYS ?? "60");
  return Number.isFinite(n) && n > 0 ? n : 60;
}

function round1(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

/** Chỉ số tool Potential; reserveCount/scale được điền sau từ trang TapTap. */
export function metricsFromPotential(row: PotentialScoreResult): RadarMetrics {
  return {
    reserveCount: null,
    downloadCount: typeof row.downloadCount === "number" ? row.downloadCount : null,
    scale: null,
    scaleKind: null,
    rating: row.rating ?? null,
    fansCount: row.fansCount ?? null,
    audienceScore: round1(row.audienceScore),
    ratingScore: round1(row.ratingScore),
    rankQualityScore: round1(row.rankQualityScore),
    dataConfidence: round1(row.dataConfidence),
    compositeScore: round1(row.compositeScore),
    momentumScore: round1(row.momentumScore),
    trend: row.trend ?? null,
    releaseDate: row.releaseDate ?? null,
  };
}

function isRecentLaunch(row: PotentialScoreResult, maxAgeDays: number, now: Date): boolean {
  if (row.releaseDate) {
    const released = new Date(`${row.releaseDate}T00:00:00.000Z`).getTime();
    if (Number.isFinite(released)) return (now.getTime() - released) / 86_400_000 <= maxAgeDays;
  }
  return row.launchCategory === "new_launch";
}

function topEntries(
  board: RadarBoardId,
  rows: PotentialScoreResult[],
  sort: "momentum" | "composite",
  limit = POTENTIAL_TOP20_LIMIT,
): RadarBoardEntry[] {
  return [...rows]
    .sort((a, b) => sortValue(b, sort) - sortValue(a, sort) || a.appId - b.appId)
    .slice(0, limit)
    .map((row, i) => ({
      board,
      rank: i + 1,
      appId: row.appId,
      title: (row.title ?? "").trim() || `App #${row.appId}`,
      score: storedScore(row, sort),
      metrics: metricsFromPotential(row),
    }));
}

/**
 * 3 bảng Radar (14 ngày, combined): Reserve tăng trưởng, Reserve quy mô, New Launch.
 * New Launch: lọc game ra mắt trong RADAR_NEW_LAUNCH_MAX_AGE_DAYS ngày (mặc định 60) theo dữ liệu crawl,
 * trả dư ứng viên — finalizeNewLaunch cắt lại top 20 sau khi đối chiếu ngày ra mắt trên TapTap.
 */
export async function computeRadarBoards(now = new Date()): Promise<RadarBoardEntry[]> {
  const [reserve, launched] = await Promise.all([
    rankingService.calculatePotentialScores(POTENTIAL_TOP20_DAYS, POTENTIAL_TOP20_PLATFORM, "reserve"),
    rankingService.calculatePotentialScores(POTENTIAL_TOP20_DAYS, POTENTIAL_TOP20_PLATFORM, "launched"),
  ]);
  const maxAge = newLaunchMaxAgeDays();
  const recent = launched.filter((row) => isRecentLaunch(row, maxAge, now));
  return [
    ...topEntries("reserve_growth", reserve, "momentum"),
    ...topEntries("reserve_scale", reserve, "composite"),
    ...topEntries("new_launch", recent, "composite", NEW_LAUNCH_CANDIDATES),
  ];
}

function daysSince(iso: string, todayIso: string): number {
  return Math.round(
    (new Date(`${todayIso}T00:00:00.000Z`).getTime() - new Date(`${iso.slice(0, 10)}T00:00:00.000Z`).getTime()) /
      86_400_000,
  );
}

/** Bỏ ứng viên New Launch có ngày ra mắt (TapTap) quá RADAR_NEW_LAUNCH_MAX_AGE_DAYS, giữ top 20 và đánh lại hạng. */
export function finalizeNewLaunch(
  entries: RadarBoardEntry[],
  facts: Map<number, RadarGameFacts>,
  todayIso: string,
): RadarBoardEntry[] {
  const maxAge = newLaunchMaxAgeDays();
  const others = entries.filter((e) => e.board !== "new_launch");
  const launch = entries
    .filter((e) => e.board === "new_launch")
    .filter((e) => {
      const released = facts.get(e.appId)?.releaseDate;
      return !released || daysSince(released, todayIso) <= maxAge;
    })
    .slice(0, POTENTIAL_TOP20_LIMIT)
    .map((e, i) => ({ ...e, rank: i + 1 }));
  return [...others, ...launch];
}
