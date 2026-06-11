import "../load-env";
import { cache, setForceRefresh } from "../utils/cache";
import {
  DISTRIBUTION_TABS,
  distributionOverviewCacheKey,
  distributionTrendsCacheKey,
  distributionService,
} from "../services/distribution.service";
import type { DistributionTab } from "../types";

const WARM_MS_THRESHOLD = 100;

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; data: T }> {
  const t0 = Date.now();
  const data = await fn();
  return { ms: Date.now() - t0, data };
}

async function benchOverview(year: number, tab: DistributionTab, cold: boolean) {
  const key = distributionOverviewCacheKey(year, tab);
  if (cold) cache.del(key);
  const { ms, data } = await timed(() => distributionService.getOverview({ year, lifecycle: tab }));
  const reserve = data.metrics.find((m) => m.metric === "reserve");
  const download = data.metrics.find((m) => m.metric === "download");
  const metric = reserve ?? download;
  console.log(
    `  overview ${tab} year=${year} ${cold ? "COLD" : "WARM"}: ${ms}ms segment=${data.segmentTotal} games=${metric?.totalGames ?? "—"}`,
  );
  if (!cold && ms > WARM_MS_THRESHOLD) {
    console.warn(`    WARN: warm overview slower than ${WARM_MS_THRESHOLD}ms`);
  }
  return ms;
}

async function benchTrends(year: number, tab: DistributionTab, cold: boolean) {
  const key = distributionTrendsCacheKey(year, tab);
  if (cold) cache.del(key);
  const { ms, data } = await timed(() => distributionService.getTrends({ year, lifecycle: tab }));
  const points = data.metrics[0]?.trend.length ?? 0;
  console.log(`  trends ${tab} year=${year} ${cold ? "COLD" : "WARM"}: ${ms}ms points=${points}`);
  if (!cold && ms > WARM_MS_THRESHOLD) {
    console.warn(`    WARN: warm trends slower than ${WARM_MS_THRESHOLD}ms`);
  }
  return ms;
}

async function main() {
  setForceRefresh(false);

  const meta = await distributionService.getMeta();
  console.log("years:", meta.years);
  const year = meta.years[0];
  if (!year) {
    console.log("no years in DB");
    return;
  }

  console.log(`\n=== Distribution smoke (year ${year}) ===\n`);

  for (const tab of DISTRIBUTION_TABS) {
    await benchOverview(year, tab, true);
    await benchOverview(year, tab, false);
    await benchTrends(year, tab, true);
    await benchTrends(year, tab, false);
  }

  console.log(`\ncache keys: ${cache.keys().length}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => process.exit(0));
