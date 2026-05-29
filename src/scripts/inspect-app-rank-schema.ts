/**
 * One-off: list AppRank columns + sample row classification.
 * Usage: DATABASE_URL=... npx tsx src/scripts/inspect-app-rank-schema.ts
 */
import "dotenv/config";
import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 15_000,
  query_timeout: 20_000,
});

async function main() {
  const cols = await pool.query(
    `SELECT column_name, data_type
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'AppRank'
     ORDER BY ordinal_position`,
  );
  console.log("=== AppRank columns ===");
  for (const c of cols.rows) console.log(`  ${c.column_name} (${c.data_type})`);

  const names = cols.rows.map((r: { column_name: string }) => r.column_name);
  const pick = (candidates: string[]) => candidates.find((c) => names.includes(c)) ?? null;

  const reserveA = pick(["reserveAndroidRank", "androidRank"]);
  const reserveI = pick(["reserveIosRank", "iosRank"]);
  const hotA = pick(["hotAndroidRank"]);
  const hotI = pick(["hotIosRank"]);
  const popA = pick(["popAndroidRank"]);
  const popI = pick(["popIosRank"]);
  const newA = pick(["newAndroidRank"]);
  const newI = pick(["newIosRank"]);

  console.log("\n=== Resolved column map ===");
  console.log({ reserveA, reserveI, hotA, hotI, popA, popI, newA, newI });

  if (reserveA) {
    const q = `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE "${reserveA}" IS NOT NULL OR "${reserveI}" IS NOT NULL)::int AS reserve,
        COUNT(*) FILTER (WHERE ("${hotA ?? "hotAndroidRank"}" IS NOT NULL OR "${hotI ?? "hotIosRank"}" IS NOT NULL))::int AS hot_any,
        COUNT(*) FILTER (WHERE ("${popA ?? "popAndroidRank"}" IS NOT NULL OR "${popI ?? "popIosRank"}" IS NOT NULL))::int AS pop_any,
        COUNT(*) FILTER (WHERE ("${newA ?? "newAndroidRank"}" IS NOT NULL OR "${newI ?? "newIosRank"}" IS NOT NULL))::int AS new_any
      FROM "AppRank"
    `;
    try {
      const counts = await pool.query(q);
      console.log("\n=== Row counts by board presence ===", counts.rows[0]);
    } catch (e) {
      console.log("Count query failed (column names may differ):", (e as Error).message);
    }
  }

  const sample = await pool.query(`SELECT * FROM "AppRank" ORDER BY "date" DESC LIMIT 1`);
  console.log("\n=== Latest row keys ===", Object.keys(sample.rows[0] ?? {}));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => pool.end());
