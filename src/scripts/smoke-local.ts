/**
 * Quick local verification after DB optimizations.
 * Run: npm run smoke:local
 */
import "../load-env";
import { pool } from "../utils/prisma";
import {
  distributionOverviewCacheKey,
  distributionService,
} from "../services/distribution.service";
import { ensureCohortEdges, getLatestCrawlDate } from "../services/distribution-cohort-store";
import { loadDistributionDiskCache } from "../services/distribution-disk-cache";

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  const out = await fn();
  console.log(`  ${label}: ${Date.now() - t0}ms`);
  return out;
}

async function main() {
  const host = process.env.DATABASE_URL?.replace(/:[^:@]+@/, ":***@").split("?")[0] ?? "(unset)";
  console.log("=== Local smoke (distribution v10) ===\n");
  console.log("DB:", host);

  await timed("ping", () => pool.query("SELECT 1"));

  const diskLoaded = await loadDistributionDiskCache();
  console.log(`  disk overview cache loaded: ${diskLoaded} key(s)`);

  const meta = await distributionService.getMeta();
  const year = meta.years[0];
  if (!year) {
    console.log("\nNo AppRank data");
    await pool.end();
    return;
  }

  console.log(`\n--- Cohort store (all-time) ---`);
  const latest = await getLatestCrawlDate();
  console.log(`  latest crawl: ${latest?.toISOString().slice(0, 10) ?? "—"}`);
  const reserveEdges = await timed("ensureCohortEdges(reserve)", () => ensureCohortEdges("reserve"));
  console.log(
    `  reserve cohort: first=${reserveEdges.firstByApp.size}, last=${reserveEdges.lastByApp.size}`,
  );

  console.log(`\n--- Download sum sanity (year ${year}, new tab) ---`);
  const overview = await distributionService.getOverview({ year, lifecycle: "new" });
  const dl = overview.metrics.find((m) => m.metric === "download");
  const bucket500k = dl?.absoluteBuckets.find((b) => b.label === "500K–1M");
  if (bucket500k) {
    const sum = bucket500k.metricSum;
    const ok = Number.isFinite(sum) && sum <= bucket500k.count * 1_000_000;
    console.log(
      `  500K–1M: ${bucket500k.count} games, metricSum=${sum}, finite=${Number.isFinite(sum)}, sane=${ok}`,
    );
    if (!ok) console.warn("  WARN: download metricSum looks wrong");
  }

  console.log(`\n--- Rating buckets ---`);
  const ratingMeta = meta.bucketDefinitions.rating;
  console.log(`  count=${ratingMeta.length}, first=${ratingMeta[0]?.label}, last=${ratingMeta[ratingMeta.length - 1]?.label}`);

  console.log(`\n--- All-time overview (cold) ---`);
  const allKey = distributionOverviewCacheKey(null, "reserve");
  const { cache } = await import("../utils/cache");
  cache.del(allKey);
  const allOverview = await timed("overview all-time reserve", () =>
    distributionService.getOverview({ year: null, lifecycle: "reserve" }),
  );
  console.log(`  segmentTotal (reserve tab): ${allOverview.segmentTotal}`);

  console.log(`\n--- All-time overview (warm) ---`);
  await timed("overview all-time reserve (cached)", () =>
    distributionService.getOverview({ year: null, lifecycle: "reserve" }),
  );

  console.log("\nOK — test FE: year=Tất cả, tab Distribution");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
