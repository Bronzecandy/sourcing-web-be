/**
 * Benchmark DB patterns used by AI review fetch — read-only, no production code changes.
 * Run: npx tsx src/scripts/bench-ai-review-db.ts
 */
import "../load-env";
import { pool } from "../utils/prisma";
import { isRetryableDbError } from "../utils/db-retry";

const BATCH = 2000;
const BUCKETS = 10;

type Timed<T> = { ms: number; ok: boolean; err?: string; code?: string; rows?: number; value?: T };

async function timed<T>(fn: () => Promise<T>): Promise<Timed<T>> {
  const t0 = Date.now();
  try {
    const value = await fn();
    return { ms: Date.now() - t0, ok: true, value };
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
  const retryable = fail.filter((f) => isRetryableDbError({ code: f.code, message: f.err }));
  return {
    n: samples.length,
    ok: ok.length,
    fail: fail.length,
    retryableFail: retryable.length,
    minMs: ms[0] ?? null,
    p50Ms: p(0.5),
    p95Ms: p(0.95),
    maxMs: ms[ms.length - 1] ?? null,
    avgMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null,
    codes: Object.fromEntries(
      [...fail.reduce((m, f) => m.set(f.code ?? "?", (m.get(f.code ?? "?") ?? 0) + 1), new Map<string, number>())],
    ),
  };
}

async function countWindow(appId: number): Promise<number> {
  const res = await pool.query<{ cnt: number }>(
    `SELECT COUNT(*)::int AS cnt FROM "AppReview" WHERE "appId" = $1 AND raw IS NOT NULL`,
    [appId],
  );
  return res.rows[0]?.cnt ?? 0;
}

async function batchFetch(appId: number, afterId: number, limit: number) {
  const res = await pool.query<{ id: number }>(
    `SELECT id FROM "AppReview"
     WHERE "appId" = $1 AND id > $2 AND raw IS NOT NULL
     ORDER BY id ASC LIMIT $3`,
    [appId, afterId, limit],
  );
  return res.rows;
}

async function dateRange(appId: number) {
  return pool.query<{ min: Date | null; max: Date | null; nulls: number }>(
    `SELECT MIN("reviewAt") AS min, MAX("reviewAt") AS max,
            COUNT(*) FILTER (WHERE "reviewAt" IS NULL)::int AS nulls
     FROM "AppReview" WHERE "appId" = $1 AND raw IS NOT NULL`,
    [appId],
  );
}

async function randomBucket(appId: number, limit: number, t0: Date, t1: Date) {
  const res = await pool.query(
    `SELECT raw, "reviewAt" FROM "AppReview"
     WHERE "appId" = $1 AND raw IS NOT NULL AND "reviewAt" >= $2 AND "reviewAt" < $3
     ORDER BY RANDOM() LIMIT $4`,
    [appId, t0, t1, limit],
  );
  return res.rows;
}

function parseRows(rows: { raw: unknown }[]): { ms: number; parsed: number } {
  const t0 = Date.now();
  let parsed = 0;
  for (const row of rows) {
    const raw = row.raw as Record<string, unknown> | null;
    const review = raw?.review as Record<string, unknown> | undefined;
    const contents = review?.contents as Record<string, unknown> | undefined;
    const text = String(contents?.text ?? "").trim();
    if (text.length >= 5) parsed++;
  }
  return { ms: Date.now() - t0, parsed };
}

async function pickSampleAppIds(): Promise<Array<{ appId: number; reviews: number }>> {
  const res = await pool.query<{ appId: number; cnt: number }>(
    `SELECT "appId", COUNT(*)::int AS cnt FROM "AppReview"
     WHERE raw IS NOT NULL GROUP BY "appId" ORDER BY cnt DESC LIMIT 8`,
  );
  const top = res.rows;
  const mid = await pool.query<{ appId: number; cnt: number }>(
    `SELECT "appId", COUNT(*)::int AS cnt FROM "AppReview"
     WHERE raw IS NOT NULL GROUP BY "appId" HAVING COUNT(*) BETWEEN 500 AND 5000
     ORDER BY RANDOM() LIMIT 2`,
  );
  const small = await pool.query<{ appId: number; cnt: number }>(
    `SELECT "appId", COUNT(*)::int AS cnt FROM "AppReview"
     WHERE raw IS NOT NULL GROUP BY "appId" HAVING COUNT(*) < 500
     ORDER BY cnt DESC LIMIT 2`,
  );
  const merged = new Map<number, number>();
  for (const r of [...top, ...mid.rows, ...small.rows]) merged.set(r.appId, r.cnt);
  return [...merged.entries()].map(([appId, reviews]) => ({ appId, reviews }));
}

async function simulateSerialBuckets(appId: number, perBucket: number) {
  const dr = await timed(() => dateRange(appId));
  if (!dr.ok || !dr.value) return { totalMs: 0, buckets: 0, rows: 0, error: dr.err };
  const minAt = dr.value.rows[0]?.min;
  const maxAt = dr.value.rows[0]?.max;
  if (!minAt || !maxAt) return { totalMs: 0, buckets: 0, rows: 0 };
  const span = maxAt.getTime() - minAt.getTime();
  const sliceMs = span / BUCKETS;
  const samples: Timed<unknown>[] = [];
  let rows = 0;
  const t0 = Date.now();
  for (let i = 0; i < BUCKETS; i++) {
    const start = new Date(minAt.getTime() + i * sliceMs);
    const end = new Date(minAt.getTime() + (i + 1) * sliceMs);
    const r = await timed(() => randomBucket(appId, perBucket, start, end));
    if (r.ok && Array.isArray(r.value)) rows += r.value.length;
    samples.push(r);
  }
  return { totalMs: Date.now() - t0, buckets: BUCKETS, rows, queryStats: stats(samples) };
}

async function simulateParallelBuckets(appId: number, perBucket: number, concurrency: number) {
  const dr = await timed(() => dateRange(appId));
  if (!dr.ok || !dr.value) return { totalMs: 0, buckets: 0, rows: 0, error: dr.err };
  const minAt = dr.value.rows[0]?.min;
  const maxAt = dr.value.rows[0]?.max;
  if (!minAt || !maxAt) return { totalMs: 0, buckets: 0, rows: 0 };
  const span = maxAt.getTime() - minAt.getTime();
  const sliceMs = span / BUCKETS;
  const tasks = Array.from({ length: BUCKETS }, (_, i) => {
    const start = new Date(minAt.getTime() + i * sliceMs);
    const end = new Date(minAt.getTime() + (i + 1) * sliceMs);
    return () => randomBucket(appId, perBucket, start, end);
  });
  const t0 = Date.now();
  const samples: Timed<unknown>[] = [];
  let rows = 0;
  for (let i = 0; i < tasks.length; i += concurrency) {
    const wave = tasks.slice(i, i + concurrency);
    const results = await Promise.all(
      wave.map((fn) =>
        timed(fn).catch((e) => ({
          ms: 0,
          ok: false as const,
          err: String((e as Error).message ?? e),
          code: (e as { code?: string }).code,
        })),
      ),
    );
    for (const r of results) {
      if (r.ok && Array.isArray(r.value)) rows += r.value.length;
      samples.push(r);
    }
  }
  return { totalMs: Date.now() - t0, buckets: BUCKETS, rows, concurrency, queryStats: stats(samples) };
}

async function simulateFullBatchWalk(appId: number, maxBatches: number) {
  let afterId = 0;
  let batches = 0;
  let rows = 0;
  const samples: Timed<unknown>[] = [];
  const t0 = Date.now();
  while (batches < maxBatches) {
    batches++;
    const r = await timed(() => batchFetch(appId, afterId, BATCH));
    samples.push(r);
    if (!r.ok || !Array.isArray(r.value) || r.value.length === 0) break;
    afterId = r.value[r.value.length - 1]!.id;
    rows += r.value.length;
    if (r.value.length < BATCH) break;
  }
  return { totalMs: Date.now() - t0, batches, rows, queryStats: stats(samples) };
}

async function hammerConcurrentCounts(appId: number, n: number, parallel: number) {
  const samples: Timed<number>[] = [];
  const t0 = Date.now();
  for (let i = 0; i < n; i += parallel) {
    const wave = Array.from({ length: Math.min(parallel, n - i) }, () => timed(() => countWindow(appId)));
    samples.push(...(await Promise.all(wave)));
  }
  return { totalMs: Date.now() - t0, parallel, ...stats(samples) };
}

async function main() {
  console.log("=== AI Review DB Benchmark (read-only) ===\n");
  const poolMax = (pool as { options?: { max?: number } }).options?.max ?? "?";
  console.log(`PG_POOL_MAX≈${process.env.PG_POOL_MAX ?? "25"} (pool.max=${poolMax})`);
  console.log(`Host: ${process.env.DATABASE_URL?.replace(/:[^:@]+@/, ":***@").split("?")[0] ?? "(unset)"}\n`);

  const ping = await timed(() => pool.query("SELECT 1"));
  console.log("Ping:", ping.ok ? `${ping.ms}ms` : `FAIL ${ping.err}`);

  const apps = await pickSampleAppIds();
  console.log("\nSample apps:", apps.map((a) => `${a.appId}(${a.reviews})`).join(", "));

  console.log("\n--- 1) Single-query latency (per app) ---");
  for (const { appId, reviews } of apps.slice(0, 5)) {
    const count = await timed(() => countWindow(appId));
    const dr = await timed(() => dateRange(appId));
    const batch = await timed(() => batchFetch(appId, 0, BATCH));
    const batchRows = batch.ok && Array.isArray(batch.value) ? batch.value.length : 0;
    console.log(
      `appId=${appId} reviews≈${reviews}: count=${count.ms}ms, dateRange=${dr.ms}ms, batch1=${batch.ms}ms (${batchRows} rows)`,
    );
  }

  const heavy = apps.find((a) => a.reviews > 25_000) ?? apps[0];
  if (heavy) {
    console.log(`\n--- 2) Heavy app ${heavy.appId} (${heavy.reviews} reviews) — stratified path ---`);
    const perBucket = Math.ceil(15_000 / BUCKETS);
    const serial = await simulateSerialBuckets(heavy.appId, perBucket);
    console.log(`Serial ${BUCKETS}×RANDOM buckets: ${serial.totalMs}ms, rows=${serial.rows}`, serial.queryStats);

    for (const c of [2, 5, 10]) {
      const par = await simulateParallelBuckets(heavy.appId, perBucket, c);
      console.log(`Parallel buckets concurrency=${c}: ${par.totalMs}ms, rows=${par.rows}`, par.queryStats);
    }

    const walk = await simulateFullBatchWalk(heavy.appId, 8);
    console.log(`Serial batch walk (max 8×${BATCH}): ${walk.totalMs}ms, batches=${walk.batches}, rows=${walk.rows}`, walk.queryStats);

    const oneBatch = await timed(async () => {
      const res = await pool.query<{ raw: unknown }>(
        `SELECT raw FROM "AppReview" WHERE "appId" = $1 AND raw IS NOT NULL ORDER BY id ASC LIMIT $2`,
        [heavy.appId, BATCH],
      );
      return res.rows;
    });
    if (oneBatch.ok && Array.isArray(oneBatch.value)) {
      const parse = parseRows(oneBatch.value);
      console.log(
        `BE parse only (${oneBatch.value.length} rows): ${parse.ms}ms → ${parse.parsed} valid (DB fetch same batch: ${oneBatch.ms}ms)`,
      );
    }
  }

  const testApp = apps[0]?.appId ?? 0;
  console.log(`\n--- 3) Concurrent COUNT hammer (appId=${testApp}) — 40001 stress ---`);
  for (const p of [1, 5, 10, 20]) {
    const h = await hammerConcurrentCounts(testApp, 15, p);
    console.log(`15 counts, parallel=${p}: wall=${h.totalMs}ms`, {
      ok: h.ok,
      fail: h.fail,
      retryableFail: h.retryableFail,
      p50Ms: h.p50Ms,
      p95Ms: h.p95Ms,
      codes: h.codes,
    });
  }

  if (heavy) {
    console.log(`\n--- 4) Payload shape (appId=${heavy.appId}) ---`);
    const idOnly = await timed(() =>
      pool.query(`SELECT id FROM "AppReview" WHERE "appId"=$1 AND raw IS NOT NULL ORDER BY id LIMIT 2000`, [
        heavy.appId,
      ]),
    );
    const withRaw = await timed(() =>
      pool.query(`SELECT id, raw FROM "AppReview" WHERE "appId"=$1 AND raw IS NOT NULL ORDER BY id LIMIT 2000`, [
        heavy.appId,
      ]),
    );
    const random1500 = await timed(() =>
      pool.query(
        `SELECT raw, "reviewAt" FROM "AppReview" WHERE "appId"=$1 AND raw IS NOT NULL ORDER BY RANDOM() LIMIT 1500`,
        [heavy.appId],
      ),
    );
    console.log(`id-only 2000 rows: ${idOnly.ms}ms, with raw JSON: ${withRaw.ms}ms, RANDOM 1500: ${random1500.ms}ms`);
  }

  console.log("\n--- 5) Retry overhead model (if 40001 on 30% batches) ---");
  const batchMs = 400;
  const scenarios = [
    { label: "no retry", pct: 0, attempts: 1 },
    { label: "30% × 1 retry (+250ms)", pct: 0.3, attempts: 2 },
    { label: "30% × 3 retries (+250+500+750ms)", pct: 0.3, attempts: 4 },
  ];
  const buckets = BUCKETS;
  for (const s of scenarios) {
    let extra = 0;
    for (let i = 0; i < buckets; i++) {
      if (Math.random() < s.pct) {
        for (let a = 1; a < s.attempts; a++) extra += 250 * a;
      }
    }
    console.log(`${s.label}: ~${buckets * batchMs + extra}ms for ${buckets} serial bucket queries (batch=${batchMs}ms baseline)`);
  }

  await pool.end();
  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
