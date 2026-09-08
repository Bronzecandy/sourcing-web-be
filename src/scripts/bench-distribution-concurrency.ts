/**
 * Probe Distribution query concurrency vs 40001 rate.
 * Read-only. No retries — measures raw replica conflict.
 *
 *   npx tsx src/scripts/bench-distribution-concurrency.ts
 *
 * Env: BENCH_ROUNDS=2  BENCH_YEAR=2026  BENCH_PAUSE_MS=8000
 */
import "../load-env";
import { pool } from "../utils/prisma";
import { runWithConcurrency } from "../utils/run-with-concurrency";
import {
  APP_RANK_DISTRIBUTION_COHORT_COLUMNS,
  APP_RANK_DISTRIBUTION_LAST_COLUMNS,
} from "../utils/app-rank-sql";
import { classifyPgError } from "../utils/pg-error";

const RESERVE_BOARD_SQL = `("reserveAndroidRank" IS NOT NULL OR "reserveIosRank" IS NOT NULL)`;
const LAUNCHED_BOARD_SQL = `(
  "hotAndroidRank" IS NOT NULL OR "hotIosRank" IS NOT NULL OR
  "popAndroidRank" IS NOT NULL OR "popIosRank" IS NOT NULL OR
  "newAndroidRank" IS NOT NULL OR "newIosRank" IS NOT NULL
)`;

type QueryOutcome = { ok: boolean; ms: number; code?: string };

type LevelScore = {
  label: string;
  concurrency: number;
  delayMs: number;
  wallMs: number;
  queries: number;
  ok: number;
  fail: number;
  failRate: number;
  conflictRate: number;
  p50Ms: number | null;
  codes: Record<string, number>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

pool.on("error", (err) => {
  const e = err as { code?: string; message?: string };
  console.warn(`[pool] idle client error ${e.code ?? ""} ${e.message ?? err}`);
});

function errCode(err: unknown): string {
  const e = err as { code?: string };
  if (e.code) return e.code;
  return classifyPgError(err);
}

function isConflict(code: string | undefined): boolean {
  const c = (code ?? "").toLowerCase();
  return c === "40001" || c.includes("conflict") || c === "replica_recovery_conflict";
}

async function distinctOn(
  periodStart: Date,
  periodEnd: Date,
  board: "reserve" | "launched",
  order: "ASC" | "DESC",
): Promise<void> {
  const boardFilter = board === "reserve" ? RESERVE_BOARD_SQL : LAUNCHED_BOARD_SQL;
  const cols = order === "DESC" ? APP_RANK_DISTRIBUTION_LAST_COLUMNS : APP_RANK_DISTRIBUTION_COHORT_COLUMNS;
  await pool.query(
    `SELECT DISTINCT ON ("appId") ${cols}
     FROM "AppRank"
     WHERE "date" >= $1::date AND "date" <= $2::date AND ${boardFilter}
     ORDER BY "appId", "date" ${order}`,
    [periodStart, periodEnd],
  );
}

async function monthCohortPair(
  periodStart: Date,
  periodEnd: Date,
  board: "reserve" | "launched",
): Promise<QueryOutcome[]> {
  const out: QueryOutcome[] = [];
  for (const order of ["ASC", "DESC"] as const) {
    const t0 = Date.now();
    try {
      await distinctOn(periodStart, periodEnd, board, order);
      out.push({ ok: true, ms: Date.now() - t0 });
    } catch (err) {
      out.push({ ok: false, ms: Date.now() - t0, code: errCode(err) });
    }
  }
  return out;
}

function summarize(
  label: string,
  concurrency: number,
  delayMs: number,
  wallMs: number,
  outcomes: QueryOutcome[],
): LevelScore {
  const ok = outcomes.filter((o) => o.ok);
  const fail = outcomes.filter((o) => !o.ok);
  const codes: Record<string, number> = {};
  for (const f of fail) {
    const k = f.code ?? "unknown";
    codes[k] = (codes[k] ?? 0) + 1;
  }
  const conflictish = fail.filter((f) => isConflict(f.code));
  const okMs = ok.map((o) => o.ms).sort((a, b) => a - b);
  const n = outcomes.length;
  return {
    label,
    concurrency,
    delayMs,
    wallMs,
    queries: n,
    ok: ok.length,
    fail: fail.length,
    failRate: n ? fail.length / n : 0,
    conflictRate: n ? conflictish.length / n : 0,
    p50Ms: okMs.length ? okMs[Math.floor(okMs.length * 0.5)]! : null,
    codes,
  };
}

function printRow(s: LevelScore) {
  const codes = Object.keys(s.codes).length ? JSON.stringify(s.codes) : "{}";
  console.log(
    `${s.label.padEnd(44)} wall=${String(s.wallMs).padStart(6)}ms  ok=${s.ok}/${s.queries}  fail=${(s.failRate * 100).toFixed(0).padStart(3)}%  conflict=${(s.conflictRate * 100).toFixed(0).padStart(3)}%  p50=${String(s.p50Ms ?? "-").padStart(5)}  ${codes}`,
  );
}

function pickBest(rows: LevelScore[]): LevelScore {
  const viable = rows.filter((r) => r.conflictRate <= 0.12 && r.failRate <= 0.2);
  const pool = viable.length > 0 ? viable : [...rows].sort((a, b) => a.conflictRate - b.conflictRate || a.wallMs - b.wallMs);
  return pool.reduce((best, r) => {
    if (r.conflictRate + 0.03 < best.conflictRate) return r;
    if (Math.abs(r.conflictRate - best.conflictRate) <= 0.03 && r.wallMs < best.wallMs * 0.85) return r;
    if (r.conflictRate <= best.conflictRate && r.wallMs < best.wallMs) return r;
    return best;
  });
}

async function latestYear(): Promise<{
  year: number;
  months: Array<{ month: number; start: Date; end: Date }>;
}> {
  const override = parseInt(process.env.BENCH_YEAR ?? "", 10);
  const { rows: yearRows } = await pool.query<{ year: number }>(
    `SELECT EXTRACT(YEAR FROM MAX("date"))::int AS year FROM "AppRank"`,
  );
  const year = Number.isFinite(override) ? override : (yearRows[0]?.year ?? new Date().getFullYear());
  const { rows } = await pool.query<{ month: number; start: Date; end: Date }>(
    `SELECT EXTRACT(MONTH FROM "date")::int AS month,
            MIN("date") AS start, MAX("date") AS end
     FROM "AppRank"
     WHERE EXTRACT(YEAR FROM "date") = $1
     GROUP BY 1
     ORDER BY 1`,
    [year],
  );
  return { year, months: rows };
}

async function runTrends(
  concurrency: number,
  months: Array<{ month: number; start: Date; end: Date }>,
  board: "reserve" | "launched",
): Promise<LevelScore> {
  const t0 = Date.now();
  const nested = await runWithConcurrency(
    months.map((m) => async () => monthCohortPair(m.start, m.end, board)),
    concurrency,
  );
  return summarize(`trends c=${concurrency} ${board}`, concurrency, 0, Date.now() - t0, nested.flat());
}

async function runOverview(
  concurrency: number,
  delayMs: number,
  periodStart: Date,
  periodEnd: Date,
): Promise<LevelScore> {
  const boards: Array<"reserve" | "launched"> = ["reserve", "launched"];
  const t0 = Date.now();
  const outcomes: QueryOutcome[] = [];
  let started = 0;
  await runWithConcurrency(
    boards.map((board) => async () => {
      const i = started;
      started += 1;
      if (delayMs > 0 && i > 0) await sleep(delayMs);
      const pair = await monthCohortPair(periodStart, periodEnd, board);
      outcomes.push(...pair);
    }),
    concurrency,
  );
  return summarize(
    `overview-year c=${concurrency} delay=${delayMs}`,
    concurrency,
    delayMs,
    Date.now() - t0,
    outcomes,
  );
}

async function main() {
  const pauseMs = Math.max(0, parseInt(process.env.BENCH_PAUSE_MS ?? "8000", 10) || 8000);
  const host = process.env.DATABASE_URL?.replace(/:[^:@]+@/, ":***@").split("?")[0] ?? "(unset)";

  console.log("=== Distribution concurrency probe (read-only, no retry) ===");
  console.log(`Host: ${host}`);
  console.log(`Pool max: ${process.env.PG_POOL_MAX ?? "8"}  pause=${pauseMs}ms\n`);

  const pingT0 = Date.now();
  await pool.query("SELECT 1");
  console.log(`Ping ${Date.now() - pingT0}ms`);

  const idx = await pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
     WHERE tablename = 'AppRank'
       AND (indexname LIKE 'apprank_%reserve%' OR indexname LIKE 'apprank_%launched%'
            OR indexname LIKE 'apprank_appid%' OR indexname LIKE 'apprank_date%')
     ORDER BY 1`,
  );
  console.log(`Indexes: ${idx.rows.map((r) => r.indexname).join(", ") || "(none matching)"}\n`);

  const { year, months } = await latestYear();
  if (months.length === 0) {
    console.log("No months — abort");
    await pool.end();
    return;
  }
  const yearStart = months[0]!.start;
  const yearEnd = months[months.length - 1]!.end;
  console.log(
    `Year ${year}: ${months.length} months  ${yearStart.toISOString().slice(0, 10)} → ${yearEnd.toISOString().slice(0, 10)}\n`,
  );

  console.log("--- A) Trends months (DISTRIBUTION_TRENDS_MONTH_CONCURRENCY) ---");
  const trendScores: LevelScore[] = [];
  const trendOrder = [2, 1, 3, 1, 2, 3];
  const trendByC = new Map<number, LevelScore[]>();
  for (const c of trendOrder) {
    try {
      const s = await runTrends(c, months, "reserve");
      printRow(s);
      const list = trendByC.get(c) ?? [];
      list.push(s);
      trendByC.set(c, list);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      console.warn(`trends c=${c} threw ${e.code ?? ""} ${e.message ?? err}`);
    }
    await sleep(pauseMs);
  }
  for (const c of [1, 2, 3]) {
    const parts = trendByC.get(c) ?? [];
    if (parts.length === 0) continue;
    const wallMs = Math.round(parts.reduce((a, p) => a + p.wallMs, 0) / parts.length);
    const queries = parts.reduce((a, p) => a + p.queries, 0);
    const ok = parts.reduce((a, p) => a + p.ok, 0);
    const fail = parts.reduce((a, p) => a + p.fail, 0);
    const codes: Record<string, number> = {};
    let conflict = 0;
    for (const p of parts) {
      for (const [k, n] of Object.entries(p.codes)) {
        codes[k] = (codes[k] ?? 0) + n;
        if (isConflict(k)) conflict += n;
      }
    }
    const p50s = parts.map((p) => p.p50Ms).filter((x): x is number => x != null);
    const avg: LevelScore = {
      label: `AVG trends c=${c}`,
      concurrency: c,
      delayMs: 0,
      wallMs,
      queries,
      ok,
      fail,
      failRate: queries ? fail / queries : 0,
      conflictRate: queries ? conflict / queries : 0,
      p50Ms: p50s.length ? Math.round(p50s.reduce((a, b) => a + b, 0) / p50s.length) : null,
      codes,
    };
    printRow(avg);
    trendScores.push(avg);
  }

  console.log("\n--- B) Year overview 2 boards (PRECOMPUTE_DISTRIBUTION_CONCURRENCY) ---");
  const overviewScores: LevelScore[] = [];
  const overviewOrder = [1, 2, 2, 1];
  const overviewByC = new Map<number, LevelScore[]>();
  for (const c of overviewOrder) {
    try {
      const s = await runOverview(c, 0, yearStart, yearEnd);
      printRow(s);
      const list = overviewByC.get(c) ?? [];
      list.push(s);
      overviewByC.set(c, list);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      console.warn(`overview c=${c} threw ${e.code ?? ""} ${e.message ?? err}`);
    }
    await sleep(pauseMs);
  }
  for (const c of [1, 2]) {
    const parts = overviewByC.get(c) ?? [];
    if (parts.length === 0) continue;
    const wallMs = Math.round(parts.reduce((a, p) => a + p.wallMs, 0) / parts.length);
    const queries = parts.reduce((a, p) => a + p.queries, 0);
    const ok = parts.reduce((a, p) => a + p.ok, 0);
    const fail = parts.reduce((a, p) => a + p.fail, 0);
    const codes: Record<string, number> = {};
    let conflict = 0;
    for (const p of parts) {
      for (const [k, n] of Object.entries(p.codes)) {
        codes[k] = (codes[k] ?? 0) + n;
        if (isConflict(k)) conflict += n;
      }
    }
    const p50s = parts.map((p) => p.p50Ms).filter((x): x is number => x != null);
    const avg: LevelScore = {
      label: `AVG overview c=${c}`,
      concurrency: c,
      delayMs: 0,
      wallMs,
      queries,
      ok,
      fail,
      failRate: queries ? fail / queries : 0,
      conflictRate: queries ? conflict / queries : 0,
      p50Ms: p50s.length ? Math.round(p50s.reduce((a, b) => a + b, 0) / p50s.length) : null,
      codes,
    };
    printRow(avg);
    overviewScores.push(avg);
  }

  const bestTrends = pickBest(trendScores);
  const overviewC1 = overviewScores.find((r) => r.concurrency === 1);
  const overviewC2 = overviewScores.find((r) => r.concurrency === 2);
  const bestOverview =
    overviewC2 &&
    overviewC1 &&
    overviewC2.conflictRate <= 0.15 &&
    overviewC2.wallMs < overviewC1.wallMs * 0.85
      ? overviewC2
      : (overviewC1 ?? pickBest(overviewScores));

  console.log("\n=== Recommendation ===");
  console.log(
    `DISTRIBUTION_TRENDS_MONTH_CONCURRENCY=${bestTrends.concurrency}  (conflict=${(bestTrends.conflictRate * 100).toFixed(0)}% wall~${bestTrends.wallMs}ms)`,
  );
  console.log(
    `PRECOMPUTE_DISTRIBUTION_CONCURRENCY=${bestOverview.concurrency}  (year DISTINCT ON — keep 1 unless c=2 is clearly faster and conflict<=15%)`,
  );

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  void pool.end();
  process.exit(1);
});
