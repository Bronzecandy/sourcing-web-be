import "../load-env";
import { distributionService } from "../services/distribution.service";

async function main() {
  const meta = await distributionService.getMeta();
  console.log("years:", meta.years.slice(0, 3));
  const y = meta.years[0];
  if (!y) {
    console.log("no years");
    return;
  }

  const t0 = Date.now();
  const yearOverview = await distributionService.getOverview({
    year: y,
    lifecycle: "reserve",
  });
  const overviewMs = Date.now() - t0;
  const reserve = yearOverview.metrics.find((m) => m.metric === "reserve");
  const growthWithData = reserve?.growthBuckets.filter((b) => b.count > 0).length ?? 0;
  console.log(
    `overview year ${y}: segment=${yearOverview.segmentTotal}, growthBuckets=${growthWithData}, tabInsights=${yearOverview.tabInsights.value}, ${overviewMs}ms`,
  );
  if (reserve && growthWithData === 0 && yearOverview.segmentTotal > 0) {
    console.warn("WARN: no growth buckets despite games in segment");
  }

  const t1 = Date.now();
  const trends = await distributionService.getTrends({ year: y, lifecycle: "reserve" });
  const trendsMs = Date.now() - t1;
  const trendPoints = trends.metrics.find((m) => m.metric === "reserve")?.trend.length ?? 0;
  console.log(`trends year ${y}: points=${trendPoints}, ${trendsMs}ms`);

  const allOverview = await distributionService.getOverview({
    year: null,
    lifecycle: "new",
  });
  console.log(
    `overview all years: segment=${allOverview.segmentTotal}, period=${allOverview.periodStart}..${allOverview.periodEnd}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => process.exit(0));
