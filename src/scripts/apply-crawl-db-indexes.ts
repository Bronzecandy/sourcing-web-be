/**
 * Apply performance indexes on crawl DB (knex-managed — not via prisma migrate deploy).
 * Run: npx tsx src/scripts/apply-crawl-db-indexes.ts
 */
import "../load-env";
import { pool } from "../utils/prisma";

const INDEXES = [
  {
    name: "apprank_date_reserve_idx",
    sql: `CREATE INDEX IF NOT EXISTS "apprank_date_reserve_idx"
      ON "AppRank" ("date", "appId")
      WHERE "reserveAndroidRank" IS NOT NULL OR "reserveIosRank" IS NOT NULL`,
  },
  {
    name: "apprank_date_launched_idx",
    sql: `CREATE INDEX IF NOT EXISTS "apprank_date_launched_idx"
      ON "AppRank" ("date", "appId")
      WHERE "hotAndroidRank" IS NOT NULL OR "hotIosRank" IS NOT NULL
         OR "popAndroidRank" IS NOT NULL OR "popIosRank" IS NOT NULL
         OR "newAndroidRank" IS NOT NULL OR "newIosRank" IS NOT NULL`,
  },
  {
    name: "appreview_appid_reviewat_idx",
    sql: `CREATE INDEX IF NOT EXISTS "appreview_appid_reviewat_idx"
      ON "AppReview" ("appId", "reviewAt")
      WHERE raw IS NOT NULL`,
  },
];

async function main() {
  const host = process.env.DATABASE_URL?.replace(/:[^:@]+@/, ":***@").split("?")[0] ?? "(unset)";
  console.log("Crawl DB:", host);
  console.log("Applying indexes (CONCURRENTLY not used — brief lock on small dev ok)...\n");

  for (const idx of INDEXES) {
    const t0 = Date.now();
    try {
      await pool.query(idx.sql);
      console.log(`OK  ${idx.name} (${Date.now() - t0}ms)`);
    } catch (e) {
      const err = e as { message?: string; code?: string };
      console.error(`FAIL ${idx.name}: [${err.code ?? "?"}] ${err.message ?? e}`);
    }
  }

  const { rows } = await pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
     WHERE tablename IN ('AppRank', 'AppReview')
       AND indexname = ANY($1::text[])`,
    [INDEXES.map((i) => i.name)],
  );
  console.log("\nVerified:", rows.map((r) => r.indexname).join(", ") || "(none)");

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
