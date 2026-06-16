/**
 * Benchmark Distribution DB patterns — read-only.
 * Run: npx tsx src/scripts/bench-distribution-db.ts
 */
import "../load-env";
import { pool } from "../utils/prisma";
import { isRetryableDbError } from "../utils/db-retry";

const RESERVE_BOARD_SQL = `("reserveAndroidRank" IS NOT NULL OR "reserveIosRank" IS NOT NULL)`;
const LAUNCHED_BOARD_SQL = `(
  "hotAndroidRank" IS NOT NULL OR "hotIosRank" IS NOT NULL OR
  "popAndroidRank" IS NOT NULL OR "popIosRank" IS NOT NULL OR
  "newAndroidRank" IS NOT NULL OR "newIosRank" IS NOT NULL
)`;

const COHORT_ROW_WITH_RAW = `
    "appId", "date",
    "reserveAndroidRank", "reserveIosRank",
    "hotAndroidRank", "hotIosRank", "popAndroidRank", "popIosRank",
    "newAndroidRank", "newIosRank",
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

const COHORT_ROW_NO_RAW = COHORT_ROW_WITH_RAW.replace(/\n\s*raw$/, "");

const SNAPSHOT_WITH_RAW = `
  SELECT "appId", "date",
    "reserveAndroidRank", "reserveIosRank",
    "hotAndroidRank", "hotIosRank", "popAndroidRank", "popIosRank",
    "newAndroidRank", "newIosRank",
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
  FROM "AppRank" WHERE "date" = $1`;

const SNAPSHOT_NO_RAW = SNAPSHOT_WITH_RAW.replace(/\n\s*raw\n/, "\n");

type Timed<T> = { ms: number; ok: boolean; err?: string; code?: string; value?: T; rows?: number };

async function timed<T>(label: string, fn: () => Promise<T>): Promise<Timed<T>> {
  const t0 = Date.now();
  try {
    const value = await fn();
    const rows = Array.isArray(value) ? value.length : (value as { rows?: unknown[] })?.rows?.length;
    return { ms: Date.now() - t0, ok: true, value, rows: typeof rows === "number" ? rows : undefined };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return {
      ms: Date.now() - t0,
      ok: false,
      err: String(err.message ?? e),
      code: err.code,
    };
  }
}

function stats(samples: Timed<unknown>[]) {
  const ok = samples.filter((s) => s.ok);
  const fail = samples.filter((s) => !s.ok);
  const ms = ok.map((s) => s.ms).sort((a, b) => a - b);
  const p = (q: number) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(q * ms.length))]! : 0);
  return {
    n: samples.length,
    ok: ok.length,
    fail: fail.length,
    retryableFail: fail.filter((f) => isRetryableDbError({ code: f.code, message: f.err })).length,
    p50Ms: p(0.5),
    p95Ms: p(0.95),
    maxMs: ms[ms.length - 1] ?? null,
    sumMs: ms.reduce((a, b) => a + b, 0),
    codes: Object.fromEntries(
      [...fail.reduce((m, f) => m.set(f.code ?? "?", (m.get(f.code ?? "?") ?? 0) + 1), new Map<string, number>())],
    ),
  };
}

async function cohortEdge(
  periodStart: Date,
  periodEnd: Date,
  board: "reserve" | "launched",
  order: "ASC" | "DESC",
  withRaw: boolean,
) {
  const boardFilter = board === "reserve" ? RESERVE_BOARD_SQL : LAUNCHED_BOARD_SQL;
  const select = withRaw ? COHORT_ROW_WITH_RAW : COHORT_ROW_NO_RAW;
  const res = await pool.query(
    `SELECT DISTINCT ON ("appId") ${select}
     FROM "AppRank"
     WHERE "date" >= $1::date AND "date" <= $2::date AND ${boardFilter}
     ORDER BY "appId", "date" ${order}`,
    [periodStart, periodEnd],
  );
  return res.rows;
}

async function cohortPair(
  periodStart: Date,
  periodEnd: Date,
  board: "reserve" | "launched",
  withRaw: boolean,
) {
  const first = await cohortEdge(periodStart, periodEnd, board, "ASC", withRaw);
  const last = await cohortEdge(periodStart, periodEnd, board, "DESC", withRaw);
  return { first, last };
}

function simulateBeAggregate(first: unknown[], last: unknown[]) {
  const t0 = Date.now();
  const firstMap = new Map<number, Record<string, unknown>>();
  const lastMap = new Map<number, Record<string, unknown>>();
  for (const r of first as Record<string, unknown>[]) firstMap.set(r.appId as number, r);
  for (const r of last as Record<string, unknown>[]) lastMap.set(r.appId as number, r);
  let processed = 0;
  for (const [appId, endRow] of lastMap) {
    const startRow = firstMap.get(appId);
    if (!startRow) continue;
    processed++;
    const download = Number(endRow.downloadCount ?? 0);
    const rating = Number(endRow.rating ?? 0);
    void download;
    void rating;
    void startRow;
  }
  return { ms: Date.now() - t0, processed };
}

async function checkIndexes() {
  const res = await pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
     WHERE tablename = 'AppRank' AND indexname LIKE 'apprank_%distribution%' OR indexname LIKE 'apprank_date_%'`,
  );
  return res.rows.map((r) => r.indexname);
}

async function main() {
  console.log("=== Distribution DB Benchmark (read-only) ===\n");
  console.log(`Host: ${process.env.DATABASE_URL?.replace(/:[^:@]+@/, ":***@").split("?")[0] ?? "(unset)"}`);

  const ping = await timed("ping", () => pool.query("SELECT 1"));
  console.log(`Ping: ${ping.ok ? `${ping.ms}ms` : ping.err}`);

  const idx = await checkIndexes();
  console.log(`Partial indexes on AppRank: ${idx.length ? idx.join(", ") : "(none found — migration may be missing)"}`);

  const meta = await timed("meta-years", () =>
    pool.query(
      `SELECT DISTINCT EXTRACT(YEAR FROM "date")::int AS year,
              EXTRACT(MONTH FROM "date")::int AS month
       FROM "AppRank" ORDER BY year DESC, month DESC LIMIT 500`,
    ),
  );
  const years = meta.ok
    ? [...new Set((meta.value as { rows: { year: number }[] }).rows.map((r) => r.year))].sort((a, b) => b - a)
    : [2025, 2024];
  const testYear = years[0] ?? 2025;
  console.log(`Years available (sample): ${years.slice(0, 5).join(", ")} — using ${testYear} for heavy tests\n`);

  const bounds = await timed(`bounds-year-${testYear}`, () =>
    pool.query<{ start: Date; end: Date }>(
      `SELECT MIN("date") AS start, MAX("date") AS end FROM "AppRank" WHERE EXTRACT(YEAR FROM "date") = $1`,
      [testYear],
    ),
  );
  if (!bounds.ok || !bounds.value) {
    console.error("Cannot resolve year bounds");
    await pool.end();
    return;
  }
  const periodStart = bounds.value.rows[0]!.start;
  const periodEnd = bounds.value.rows[0]!.end;
  console.log(`Period ${testYear}: ${periodStart.toISOString().slice(0, 10)} → ${periodEnd.toISOString().slice(0, 10)}\n`);

  console.log("--- 1) Meta / bounds (light queries) ---");
  const monthlyBounds = await timed("monthly-bounds", () =>
    pool.query(
      `SELECT EXTRACT(MONTH FROM "date")::int AS month, MIN("date") AS start, MAX("date") AS end
       FROM "AppRank" WHERE EXTRACT(YEAR FROM "date") = $1 GROUP BY 1 ORDER BY 1`,
      [testYear],
    ),
  );
  const reserveCount = await timed("reserve-distinct-count", () =>
    pool.query(
      `SELECT COUNT(DISTINCT "appId")::text AS count FROM "AppRank"
       WHERE "date" >= $1::date AND "date" <= $2::date AND ${RESERVE_BOARD_SQL}`,
      [periodStart, periodEnd],
    ),
  );
  console.log(`meta: ${meta.ms}ms, monthly-bounds: ${monthlyBounds.ms}ms, reserve COUNT DISTINCT: ${reserveCount.ms}ms`);

  console.log("\n--- 2) Cohort DISTINCT ON (core overview query) — full year ---");
  for (const board of ["reserve", "launched"] as const) {
    for (const withRaw of [true, false]) {
      const label = `${board} withRaw=${withRaw}`;
      const pair = await timed(label, () => cohortPair(periodStart, periodEnd, board, withRaw));
      if (pair.ok && pair.value) {
        const be = simulateBeAggregate(pair.value.first, pair.value.last);
        console.log(
          `${label}: wall=${pair.ms}ms, first=${pair.value.first.length} last=${pair.value.last.length} rows, BE aggregate=${be.ms}ms`,
        );
      } else {
        console.log(`${label}: FAIL ${pair.code} ${pair.err} (${pair.ms}ms)`);
      }
    }
  }

  console.log("\n--- 3) Daily snapshot (single date) ---");
  const snapDate = periodEnd;
  const snapRaw = await timed("snapshot-with-raw", () => pool.query(SNAPSHOT_WITH_RAW, [snapDate]));
  const snapNoRaw = await timed("snapshot-no-raw", () => pool.query(SNAPSHOT_NO_RAW, [snapDate]));
  console.log(
    `date=${snapDate.toISOString().slice(0, 10)}: with raw=${snapRaw.ms}ms (${snapRaw.rows} rows), no raw=${snapNoRaw.ms}ms (${snapNoRaw.rows} rows)`,
  );

  console.log(`\n--- 4) Simulate overview (${testYear} full year, 3 tabs) ---`);
  const tabs: Array<"reserve" | "launched-new" | "launched-old"> = ["reserve", "launched-new", "launched-old"];
  const overviewSerial: Timed<unknown>[] = [];
  const tOverview0 = Date.now();
  for (const tab of tabs) {
    if (tab === "reserve") {
      const r = await timed("tab-reserve", () => cohortPair(periodStart, periodEnd, "reserve", true));
      overviewSerial.push(r);
    } else {
      const r = await timed(`tab-${tab}`, () => cohortPair(periodStart, periodEnd, "launched", true));
      overviewSerial.push(r);
    }
  }
  console.log(`Serial 3 tabs (reserve=1 cohort, new/old share launched): wall=${Date.now() - tOverview0}ms`, stats(overviewSerial));

  console.log(`\n--- 5) Simulate trends (${testYear}, 12 months × reserve cohort) ---`);
  if (!monthlyBounds.ok || !monthlyBounds.value) {
    console.log("skip — no monthly bounds");
  } else {
    const months = (monthlyBounds.value as { rows: { month: number; start: Date; end: Date }[] }).rows;
    const runMonths = async (concurrency: number) => {
      const samples: Timed<unknown>[] = [];
      const t0 = Date.now();
      for (let i = 0; i < months.length; i += concurrency) {
        const wave = months.slice(i, i + concurrency);
        const results = await Promise.all(
          wave.map((m) =>
            timed(`month-${m.month}`, () => cohortPair(m.start, m.end, "reserve", true)),
          ),
        );
        samples.push(...results);
      }
      return { wallMs: Date.now() - t0, queryStats: stats(samples) };
    };
    for (const c of [1, 2, 4]) {
      const r = await runMonths(c);
      console.log(`12 months reserve cohort, concurrency=${c}: wall=${r.wallMs}ms`, r.queryStats);
    }
  }

  console.log(`\n--- 6) Precompute-style load (${years.length} years × 3 tabs overview) ---`);
  const precomputeSamples: Timed<unknown>[] = [];
  const tPre0 = Date.now();
  for (const year of years.slice(0, 4)) {
    const b = await pool.query<{ start: Date; end: Date }>(
      `SELECT MIN("date") AS start, MAX("date") AS end FROM "AppRank" WHERE EXTRACT(YEAR FROM "date") = $1`,
      [year],
    );
    const ps = b.rows[0]?.start;
    const pe = b.rows[0]?.end;
    if (!ps || !pe) continue;
    for (const board of ["reserve", "launched"] as const) {
      const r = await timed(`y${year}-${board}`, () => cohortPair(ps, pe, board, true));
      precomputeSamples.push(r);
    }
  }
  console.log(
    `4 years × 2 boards (serial, no cache): wall=${Date.now() - tPre0}ms`,
    stats(precomputeSamples),
  );

  console.log("\n--- 7) Parallel cohort stress (same year reserve, N concurrent pairs) ---");
  for (const n of [2, 4, 8]) {
    const samples: Timed<unknown>[] = [];
    const t0 = Date.now();
    const tasks = Array.from({ length: n }, (_, i) =>
      timed(`parallel-${i}`, () => cohortPair(periodStart, periodEnd, "reserve", true)),
    );
    samples.push(...(await Promise.all(tasks)));
    console.log(`${n} concurrent cohort pairs: wall=${Date.now() - t0}ms`, stats(samples));
  }

  await pool.end();
  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
