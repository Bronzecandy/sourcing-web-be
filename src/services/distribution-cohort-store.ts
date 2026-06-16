import fs from "fs/promises";
import path from "path";
import { pool } from "../utils/prisma";
import { withDbRetry } from "../utils/db-retry";
import {
  hasLaunchedRank,
  hasReserveRank,
  type AppRankRow,
} from "../utils/app-rank";
import {
  APP_RANK_DISTRIBUTION_COHORT_COLUMNS,
  APP_RANK_DISTRIBUTION_LAST_COLUMNS,
  APP_RANK_VOTE5_SHARE_SQL,
} from "../utils/app-rank-sql";
import { toFiniteNumber } from "../utils/to-finite-number";
import { parseAppRankRow } from "./distribution-row-utils";

export type CohortBoard = "reserve" | "launched";

export type CohortEdgeRows = {
  firstByApp: Map<number, AppRankRow>;
  lastByApp: Map<number, AppRankRow>;
};

const RESERVE_BOARD_SQL = `("reserveAndroidRank" IS NOT NULL OR "reserveIosRank" IS NOT NULL)`;
const LAUNCHED_BOARD_SQL = `(
  "hotAndroidRank" IS NOT NULL OR "hotIosRank" IS NOT NULL OR
  "popAndroidRank" IS NOT NULL OR "popIosRank" IS NOT NULL OR
  "newAndroidRank" IS NOT NULL OR "newIosRank" IS NOT NULL
)`;

const HEAVY_DB_RETRY = {
  maxAttempts: Math.max(1, parseInt(process.env.DISTRIBUTION_DB_MAX_ATTEMPTS ?? "5", 10) || 5),
  delayMs: Math.max(500, parseInt(process.env.DISTRIBUTION_DB_RETRY_DELAY_MS ?? "3000", 10) || 3000),
};

const COHORT_DIR = path.join(process.cwd(), "data", "distribution-cohort");
/** Bump when cohort semantics change — forces rebuild of on-disk store. */
const COHORT_STORE_VERSION = 2;

interface StoredCohortFile {
  schemaVersion?: number;
  board: CohortBoard;
  lastProcessedDate: string | null;
  builtAt: string;
  firstByApp: Record<string, unknown>;
  lastByApp: Record<string, unknown>;
}

function boardSql(board: CohortBoard): string {
  return board === "reserve" ? RESERVE_BOARD_SQL : LAUNCHED_BOARD_SQL;
}

function rowOnBoard(row: AppRankRow, board: CohortBoard): boolean {
  return board === "reserve" ? hasReserveRank(row) : hasLaunchedRank(row);
}

function cohortFilePath(board: CohortBoard): string {
  return path.join(COHORT_DIR, `${board}.json`);
}

function serializeRow(row: AppRankRow): Record<string, unknown> {
  return {
    ...row,
    date: row.date instanceof Date ? row.date.toISOString().split("T")[0] : row.date,
    releaseDate:
      row.releaseDate instanceof Date
        ? row.releaseDate.toISOString()
        : row.releaseDate ?? null,
  };
}

function deserializeRow(raw: Record<string, unknown>): AppRankRow {
  const date = raw.date ? new Date(String(raw.date)) : new Date();
  const releaseDate = raw.releaseDate ? new Date(String(raw.releaseDate)) : null;
  return {
    appId: Number(raw.appId),
    date,
    reserveAndroidRank: (raw.reserveAndroidRank as number | null) ?? null,
    reserveIosRank: (raw.reserveIosRank as number | null) ?? null,
    hotAndroidRank: (raw.hotAndroidRank as number | null) ?? null,
    hotIosRank: (raw.hotIosRank as number | null) ?? null,
    popAndroidRank: (raw.popAndroidRank as number | null) ?? null,
    popIosRank: (raw.popIosRank as number | null) ?? null,
    newAndroidRank: (raw.newAndroidRank as number | null) ?? null,
    newIosRank: (raw.newIosRank as number | null) ?? null,
    fansCount: toFiniteNumber(raw.fansCount),
    reserveCount: toFiniteNumber(raw.reserveCount),
    downloadCount: toFiniteNumber(raw.downloadCount),
    rating: (raw.rating as string | null) ?? null,
    reviewCount: toFiniteNumber(raw.reviewCount),
    releaseDate,
    vote5StarShare: toFiniteNumber(raw.vote5StarShare),
  };
}

function mapFromStored(obj: Record<string, unknown>): Map<number, AppRankRow> {
  const m = new Map<number, AppRankRow>();
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object") m.set(Number(k), deserializeRow(v as Record<string, unknown>));
  }
  return m;
}

function mapToStored(m: Map<number, AppRankRow>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const [appId, row] of m) o[String(appId)] = serializeRow(row);
  return o;
}

async function saveCohort(
  board: CohortBoard,
  edges: CohortEdgeRows,
  lastProcessedDate: string,
): Promise<void> {
  await fs.mkdir(COHORT_DIR, { recursive: true });
  const payload: StoredCohortFile = {
    schemaVersion: COHORT_STORE_VERSION,
    board,
    lastProcessedDate,
    builtAt: new Date().toISOString(),
    firstByApp: mapToStored(edges.firstByApp),
    lastByApp: mapToStored(edges.lastByApp),
  };
  await fs.writeFile(cohortFilePath(board), JSON.stringify(payload), "utf8");
}

async function loadCohortFromDisk(board: CohortBoard): Promise<StoredCohortFile | null> {
  try {
    const raw = await fs.readFile(cohortFilePath(board), "utf8");
    return JSON.parse(raw) as StoredCohortFile;
  } catch {
    return null;
  }
}

export async function getLatestCrawlDate(): Promise<Date | null> {
  const { rows } = await withDbRetry(
    () => pool.query<{ max: Date | null }>(`SELECT MAX("date") AS max FROM "AppRank"`),
    "distribution-cohort-max-date",
    HEAVY_DB_RETRY,
  );
  return rows[0]?.max ?? null;
}

async function fetchSnapshotRows(date: Date): Promise<Map<number, AppRankRow>> {
  const { rows } = await withDbRetry(
    () =>
      pool.query(
        `SELECT ${APP_RANK_DISTRIBUTION_LAST_COLUMNS}
         FROM "AppRank" WHERE "date" = $1::date`,
        [date],
      ),
    `distribution-cohort-snapshot-${date.toISOString().slice(0, 10)}`,
    HEAVY_DB_RETRY,
  );
  const map = new Map<number, AppRankRow>();
  for (const r of rows as Record<string, unknown>[]) {
    const row = parseAppRankRow(r);
    map.set(row.appId, row);
  }
  return map;
}

async function enrichVote5(rows: AppRankRow[], snapshotDate: Date): Promise<void> {
  const appIds = rows.map((r) => r.appId);
  if (appIds.length === 0) return;
  const { rows: voteRows } = await withDbRetry(
    () =>
      pool.query<{ appId: number; vote5StarShare: string | number | null }>(
        `SELECT "appId", ${APP_RANK_VOTE5_SHARE_SQL} AS "vote5StarShare"
         FROM "AppRank"
         WHERE "date" = $1::date AND "appId" = ANY($2::int[])`,
        [snapshotDate, appIds],
      ),
    "distribution-cohort-vote5",
    HEAVY_DB_RETRY,
  );
  const byApp = new Map(voteRows.map((r) => [r.appId, r.vote5StarShare]));
  for (const row of rows) {
    row.vote5StarShare = toFiniteNumber(byApp.get(row.appId));
  }
}

async function enrichVote5ByRowDates(rows: AppRankRow[]): Promise<void> {
  const byDate = new Map<string, AppRankRow[]>();
  for (const row of rows) {
    const d = row.date.toISOString().split("T")[0]!;
    const list = byDate.get(d) ?? [];
    list.push(row);
    byDate.set(d, list);
  }
  for (const [d, group] of byDate) {
    await enrichVote5(group, new Date(`${d}T00:00:00.000Z`));
  }
}

async function fetchLastCohortRows(board: CohortBoard): Promise<AppRankRow[]> {
  const filter = boardSql(board);
  const { rows: lastRows } = await withDbRetry(
    () =>
      pool.query(
        `SELECT DISTINCT ON ("appId") ${APP_RANK_DISTRIBUTION_LAST_COLUMNS}
         FROM "AppRank"
         WHERE ${filter}
         ORDER BY "appId", "date" DESC`,
      ),
    `distribution-cohort-rebuild-last-${board}`,
    HEAVY_DB_RETRY,
  );
  return (lastRows as Record<string, unknown>[]).map((r) => parseAppRankRow(r));
}

async function rebuildCohortEdges(board: CohortBoard): Promise<CohortEdgeRows> {
  const latest = await getLatestCrawlDate();
  if (!latest) return { firstByApp: new Map(), lastByApp: new Map() };

  const filter = boardSql(board);
  const { rows: firstRows } = await withDbRetry(
    () =>
      pool.query(
        `SELECT DISTINCT ON ("appId") ${APP_RANK_DISTRIBUTION_COHORT_COLUMNS}
         FROM "AppRank"
         WHERE ${filter}
         ORDER BY "appId", "date" ASC`,
      ),
    `distribution-cohort-rebuild-first-${board}`,
    HEAVY_DB_RETRY,
  );

  const lastRowList = await fetchLastCohortRows(board);
  await enrichVote5ByRowDates(lastRowList);

  const firstByApp = new Map<number, AppRankRow>();
  for (const r of firstRows as Record<string, unknown>[]) {
    firstByApp.set(r.appId as number, parseAppRankRow(r));
  }
  const lastByApp = new Map<number, AppRankRow>();
  for (const row of lastRowList) lastByApp.set(row.appId, row);

  const edges = { firstByApp, lastByApp };
  await saveCohort(board, edges, latest.toISOString().split("T")[0]!);
  return edges;
}

async function listCrawlDatesAfter(after: string): Promise<string[]> {
  const { rows } = await withDbRetry(
    () =>
      pool.query<{ d: string }>(
        `SELECT DISTINCT to_char("date", 'YYYY-MM-DD') AS d
         FROM "AppRank"
         WHERE "date" > $1::date
         ORDER BY d ASC`,
        [after],
      ),
    "distribution-cohort-dates-after",
    HEAVY_DB_RETRY,
  );
  return rows.map((r) => r.d);
}

function mergeSnapshotIntoEdges(
  edges: CohortEdgeRows,
  snapshot: Map<number, AppRankRow>,
  board: CohortBoard,
): void {
  for (const [appId, row] of snapshot) {
    if (!rowOnBoard(row, board)) continue;
    if (!edges.firstByApp.has(appId)) edges.firstByApp.set(appId, row);
    const prev = edges.lastByApp.get(appId);
    if (!prev || row.date >= prev.date) {
      edges.lastByApp.set(appId, row);
    }
  }
}

function needsCohortRebuild(stored: StoredCohortFile | null): boolean {
  if (!stored || !stored.lastProcessedDate) return true;
  if ((stored.schemaVersion ?? 1) < COHORT_STORE_VERSION) return true;
  const firstN = Object.keys(stored.firstByApp).length;
  const lastN = Object.keys(stored.lastByApp).length;
  // v1 bug: last ≈ current snapshot only — far fewer than first-edge set
  if (firstN > 0 && lastN > 0 && lastN < firstN * 0.5) return true;
  return false;
}

/** Load materialized cohort edges; rebuild or incrementally merge new crawl days. */
export async function ensureCohortEdges(board: CohortBoard): Promise<CohortEdgeRows> {
  const latest = await getLatestCrawlDate();
  if (!latest) return { firstByApp: new Map(), lastByApp: new Map() };

  const latestStr = latest.toISOString().split("T")[0]!;
  const stored = await loadCohortFromDisk(board);

  if (needsCohortRebuild(stored)) {
    return rebuildCohortEdges(board);
  }

  let firstByApp = mapFromStored(stored!.firstByApp);
  let lastByApp = mapFromStored(stored!.lastByApp);

  if (stored!.lastProcessedDate! >= latestStr) {
    return { firstByApp, lastByApp };
  }

  const newDates = await listCrawlDatesAfter(stored!.lastProcessedDate!);
  let lastProcessed = stored!.lastProcessedDate!;

  for (const d of newDates) {
    const snap = await fetchSnapshotRows(new Date(`${d}T00:00:00.000Z`));
    mergeSnapshotIntoEdges({ firstByApp, lastByApp }, snap, board);
    lastProcessed = d;
  }

  const updatedLast = [...lastByApp.values()];
  await enrichVote5ByRowDates(updatedLast);
  for (const row of updatedLast) lastByApp.set(row.appId, row);

  const edges = { firstByApp, lastByApp };
  await saveCohort(board, edges, lastProcessed);
  return edges;
}

/** Refresh both boards (cron / warm-up). */
export async function refreshCohortStore(): Promise<void> {
  for (const board of ["reserve", "launched"] as const) {
    await ensureCohortEdges(board);
  }
}
