/**
 * AppRank column helpers after DB migration (reserve / hot / pop / new boards).
 */

export type PotentialSegment = "reserve" | "launched";

export type LaunchCategory = "new_launch" | "established_launch";

/** Launch chart priority when a game appears on multiple boards: Pop > Hot > New */
export type PrimaryLaunchBoard = "pop" | "hot" | "new";

export interface AppRankRow {
  appId: number;
  date: Date;
  reserveAndroidRank: number | null;
  reserveIosRank: number | null;
  hotAndroidRank: number | null;
  hotIosRank: number | null;
  popAndroidRank: number | null;
  popIosRank: number | null;
  newAndroidRank: number | null;
  newIosRank: number | null;
  title?: string | null;
  iconUrl?: string | null;
  rating?: string | null;
  fansCount?: number | null;
  reserveCount?: number | null;
  downloadCount?: number | null;
  raw?: unknown;
}

export interface LaunchBoardTag {
  board: PrimaryLaunchBoard;
  rank: number | null;
}

const APP_RANK_LIGHT_COLUMNS = `
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
    raw->>'title' AS title,
    raw->'icon'->>'url' AS "iconUrl",
    raw->'stat'->'rating'->>'score' AS rating,
    (raw->'stat'->>'fans_count')::int AS "fansCount",
    (raw->'stat'->>'reserve_count')::int AS "reserveCount",
    (raw->'stat'->>'hits_total')::bigint AS "downloadCount"`;

export const APP_RANK_LIGHT_SELECT_SQL = `
  SELECT
${APP_RANK_LIGHT_COLUMNS}
  FROM "AppRank"
  WHERE "date" >= $1
  ORDER BY "date" ASC
`;

/** Per-app rows in [from, to) — used for Reserve window ending at first launch. */
export const APP_RANK_APP_DATE_RANGE_SQL = `
  SELECT
${APP_RANK_LIGHT_COLUMNS}
  FROM "AppRank"
  WHERE "appId" = $1 AND "date" >= $2 AND "date" < $3
  ORDER BY "date" ASC
`;

export function hasReserveRank(row: AppRankRow): boolean {
  return row.reserveAndroidRank != null || row.reserveIosRank != null;
}

export function hasLaunchedRank(row: AppRankRow): boolean {
  return (
    row.hotAndroidRank != null ||
    row.hotIosRank != null ||
    row.popAndroidRank != null ||
    row.popIosRank != null ||
    row.newAndroidRank != null ||
    row.newIosRank != null
  );
}

export function hasNewBoardRank(row: AppRankRow): boolean {
  return row.newAndroidRank != null || row.newIosRank != null;
}

export function classifyLaunchCategory(row: AppRankRow): LaunchCategory | null {
  if (!hasLaunchedRank(row)) return null;
  if (hasNewBoardRank(row)) return "new_launch";
  return "established_launch";
}

/** Best (lowest) rank on reserve board for platform. */
export function reserveRank(
  row: AppRankRow,
  platform: "combined" | "android" | "ios",
): number | null {
  const a = row.reserveAndroidRank;
  const i = row.reserveIosRank;
  if (platform === "android") return a;
  if (platform === "ios") return i;
  if (a != null && i != null) return Math.min(a, i);
  return a ?? i;
}

function platformPairRank(
  android: number | null,
  ios: number | null,
  platform: "combined" | "android" | "ios",
): number | null {
  if (platform === "android") return android;
  if (platform === "ios") return ios;
  if (android != null && ios != null) return Math.min(android, ios);
  return android ?? ios;
}

function boardRanks(
  row: AppRankRow,
  board: PrimaryLaunchBoard,
): { android: number | null; ios: number | null } {
  switch (board) {
    case "pop":
      return { android: row.popAndroidRank, ios: row.popIosRank };
    case "hot":
      return { android: row.hotAndroidRank, ios: row.hotIosRank };
    case "new":
      return { android: row.newAndroidRank, ios: row.newIosRank };
  }
}

/** Primary launch board by priority Pop > Hot > New for the given platform. */
export function primaryLaunchBoard(
  row: AppRankRow,
  platform: "combined" | "android" | "ios",
): PrimaryLaunchBoard | null {
  const order: PrimaryLaunchBoard[] = ["pop", "hot", "new"];
  for (const board of order) {
    const { android, ios } = boardRanks(row, board);
    if (platformPairRank(android, ios, platform) != null) return board;
  }
  return null;
}

/** Rank on a specific launch board for the given platform. */
export function rankForLaunchBoard(
  row: AppRankRow,
  board: PrimaryLaunchBoard,
  platform: "combined" | "android" | "ios",
): number | null {
  const { android, ios } = boardRanks(row, board);
  return platformPairRank(android, ios, platform);
}

/** Rank from the highest-priority launch board that has data (Pop > Hot > New). */
export function launchedPriorityRank(
  row: AppRankRow,
  platform: "combined" | "android" | "ios",
): number | null {
  const board = primaryLaunchBoard(row, platform);
  if (!board) return null;
  const { android, ios } = boardRanks(row, board);
  return platformPairRank(android, ios, platform);
}

/** @deprecated Use launchedPriorityRank — kept as alias */
export const launchedRank = launchedPriorityRank;

/** Count how many launch boards (pop/hot/new) have a rank on this row for the platform. */
export function launchBoardCount(row: AppRankRow, platform: "combined" | "android" | "ios"): number {
  return activeLaunchBoards(row, platform).length;
}

/** All launch boards present on this row (Pop, Hot, New order) with platform rank. */
export function activeLaunchBoards(
  row: AppRankRow,
  platform: "combined" | "android" | "ios",
): LaunchBoardTag[] {
  const out: LaunchBoardTag[] = [];
  for (const board of ["pop", "hot", "new"] as const) {
    const { android, ios } = boardRanks(row, board);
    const rank = platformPairRank(android, ios, platform);
    if (rank != null) out.push({ board, rank });
  }
  return out;
}

export { releaseDateFromRaw, releaseDateIsoFromRaw } from "./taptap-raw-extract";

export interface AppLifecycleMeta {
  firstLaunchDate: string | null;
  firstLaunchIndex: number;
  hasReservePhase: boolean;
  hasLaunchPhase: boolean;
  preLaunchDayCount: number;
  postLaunchDayCount: number;
  transitioned: boolean;
  /** Reserve scoring window ends at first launch (exclusive). */
  reserveWindowEnd?: string | null;
  reserveWindowDays?: number;
}

/** Rows strictly before the first Hot/Pop/New snapshot. */
export function slicePreLaunchRows(appRows: AppRankRow[]): AppRankRow[] {
  const idx = appRows.findIndex((r) => hasLaunchedRank(r));
  if (idx < 0) return appRows;
  return appRows.slice(0, idx);
}

/** Lifecycle stats for a single app within an ordered date window (ASC). */
export function computeAppLifecycle(appRows: AppRankRow[]): AppLifecycleMeta {
  const launchIdx = appRows.findIndex((r) => hasLaunchedRank(r));
  const hasReservePhase = appRows.some((r) => hasReserveRank(r));
  const hasLaunchPhase = launchIdx >= 0;
  const preLaunchDayCount = launchIdx >= 0 ? launchIdx : hasReservePhase ? appRows.length : 0;
  const postLaunchDayCount = launchIdx >= 0 ? appRows.length - launchIdx : 0;
  const firstLaunchDate =
    launchIdx >= 0
      ? appRows[launchIdx]!.date.toISOString().split("T")[0]!
      : null;

  return {
    firstLaunchDate,
    firstLaunchIndex: launchIdx,
    hasReservePhase,
    hasLaunchPhase,
    preLaunchDayCount,
    postLaunchDayCount,
    transitioned: hasReservePhase && hasLaunchPhase && launchIdx > 0,
  };
}
