import type { AppRankRow } from "../utils/app-rank";
import { toFiniteNumber } from "../utils/to-finite-number";

export function parseAppRankRow(r: Record<string, unknown>): AppRankRow {
  const releaseRaw = r.releaseDate;
  let releaseDate: Date | null = null;
  if (releaseRaw instanceof Date) releaseDate = releaseRaw;
  else if (releaseRaw != null && releaseRaw !== "") {
    const d = new Date(String(releaseRaw));
    if (!Number.isNaN(d.getTime())) releaseDate = d;
  }

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
    fansCount: toFiniteNumber(r.fansCount),
    reserveCount: toFiniteNumber(r.reserveCount),
    downloadCount: toFiniteNumber(r.downloadCount),
    rating: r.rating as string | null,
    reviewCount: toFiniteNumber(r.reviewCount),
    releaseDate,
    vote5StarShare: toFiniteNumber(r.vote5StarShare),
  };
}
