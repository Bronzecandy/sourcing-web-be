/**
 * SQL fragments for AppRank — extract TapTap JSON fields without transferring full `raw`.
 * Mirrors logic in taptap-raw-extract.ts.
 */

/** Convert a JSON text path (scalar) to timestamptz (seconds, ms, or ISO string). */
function jsonTsExpr(jsonPath: string): string {
  return `CASE
    WHEN ${jsonPath} IS NULL OR btrim(${jsonPath}) = '' THEN NULL::timestamptz
    WHEN ${jsonPath} ~ '^[0-9]+$' THEN to_timestamp(
      CASE WHEN (${jsonPath})::bigint < 10000000000
        THEN (${jsonPath})::bigint
        ELSE (${jsonPath})::bigint / 1000
      END
    )
    ELSE (${jsonPath})::timestamptz
  END`;
}

const RELEASE_DATE_KEYS = [
  "release_date",
  "released_time",
  "release_time",
  "publish_time",
  "published_time",
  "online_time",
] as const;

const RELEASE_DATE_PATHS = RELEASE_DATE_KEYS.flatMap((k) => [
  `raw->>'${k}'`,
  `raw#>>'{app,${k}}'`,
]);

export const APP_RANK_RELEASE_DATE_SQL = `COALESCE(${RELEASE_DATE_PATHS.map(jsonTsExpr).join(",\n    ")})`;

const VOTE_INFO_JSON = `COALESCE(raw->'stat'->'vote_info', raw->'app'->'stat'->'vote_info')`;

/** Sum vote_info keys 1–5 without jsonb_each (cheaper on large DISTINCT ON scans). */
export const APP_RANK_VOTE5_SHARE_SQL = `(
  WITH vi AS (SELECT ${VOTE_INFO_JSON} AS j)
  SELECT CASE WHEN s.total > 0
    THEN round((s.five / s.total) * 1000) / 10
    ELSE NULL
  END
  FROM (
    SELECT
      COALESCE((vi.j->>'5')::numeric, 0) AS five,
      COALESCE((vi.j->>'1')::numeric, 0) +
      COALESCE((vi.j->>'2')::numeric, 0) +
      COALESCE((vi.j->>'3')::numeric, 0) +
      COALESCE((vi.j->>'4')::numeric, 0) +
      COALESCE((vi.j->>'5')::numeric, 0) AS total
    FROM vi
  ) s
)`;

const STAT_DOWNLOAD_SQL = `(COALESCE(
  NULLIF((raw->'stat'->>'hits_total')::bigint, 0),
  NULLIF((raw->'stat'->>'download_count')::bigint, 0),
  NULLIF((raw->'stat'->>'pc_download_count')::bigint, 0),
  NULLIF((raw->'stat'->>'play_total')::bigint, 0),
  NULLIF((raw->'app'->'stat'->>'hits_total')::bigint, 0),
  NULLIF((raw->'app'->'stat'->>'download_count')::bigint, 0),
  NULLIF((raw->'app'->'stat'->>'pc_download_count')::bigint, 0),
  NULLIF((raw->'app'->'stat'->>'play_total')::bigint, 0)
))::float8`;

const STAT_FANS_SQL = `COALESCE(
  (raw->'stat'->>'fans_count')::int,
  (raw->'app'->'stat'->>'fans_count')::int
)`;

const STAT_RESERVE_SQL = `COALESCE(
  (raw->'stat'->>'reserve_count')::int,
  (raw->'app'->'stat'->>'reserve_count')::int
)`;

const STAT_RATING_SQL = `COALESCE(
  raw->'stat'->'rating'->>'score',
  raw->'app'->'stat'->'rating'->>'score'
)`;

const STAT_REVIEW_COUNT_SQL = `COALESCE(
  (raw->'stat'->>'review_count')::int,
  (raw->'app'->'stat'->>'review_count')::int
)`;

/** Columns for distribution cohort edges (metrics only — no release/vote5 on scan). */
export const APP_RANK_DISTRIBUTION_COHORT_COLUMNS = `
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
    ${STAT_FANS_SQL} AS "fansCount",
    ${STAT_RESERVE_SQL} AS "reserveCount",
    ${STAT_DOWNLOAD_SQL} AS "downloadCount",
    ${STAT_RATING_SQL} AS rating,
    ${STAT_REVIEW_COUNT_SQL} AS "reviewCount"`;

/** Last cohort edge + daily snapshot — includes release date for tab classification. */
export const APP_RANK_DISTRIBUTION_LAST_COLUMNS = `${APP_RANK_DISTRIBUTION_COHORT_COLUMNS},
    ${APP_RANK_RELEASE_DATE_SQL} AS "releaseDate"`;

/** Full distribution row (snapshot / enrichment). */
export const APP_RANK_DISTRIBUTION_COLUMNS = `${APP_RANK_DISTRIBUTION_LAST_COLUMNS},
    ${APP_RANK_VOTE5_SHARE_SQL} AS "vote5StarShare"`;
