import { frameworks, matchPattern } from "./frameworks";
import {
  addMonths,
  daysAgo,
  daysInMonth,
  lastFullMonth,
  stCohort,
  stDailySeries,
  stMonthlySeries,
  stSubgenreTrend,
  type CohortRow,
  type StGameInfo,
} from "./st-data";
import { steamRaw, type SteamInfo } from "./steam-data";
import type { Country, MarketReport, MarketSeries, MetricScore, SteamReport } from "./types";

type MonthRow = MarketSeries["monthly"][number];

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const round = (v: number | null, digits = 1) => (v === null ? null : Math.round(v * 10 ** digits) / 10 ** digits);
const positive = (v: number | null | undefined): v is number => typeof v === "number" && v > 0;

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function percentileOf(values: number[], x: number): number | null {
  if (!values.length) return null;
  let below = 0;
  let equal = 0;
  for (const v of values) {
    if (v < x) below++;
    else if (v === x) equal++;
  }
  return ((below + equal * 0.5) / values.length) * 100;
}

function growth(current: number | null, prior: Array<number | null>): number | null {
  const base = mean(prior.filter(positive));
  if (current === null || base === null || prior.filter(positive).length < 2) return null;
  return current / base - 1;
}

interface Derived {
  revenue: number | null;
  dau: number | null;
  downloads: number | null;
  arpdau: number | null;
  rpd: number | null;
  stickiness: number | null;
}

function derive(row: { revenueUsd: number | null; avgDau: number | null; downloads: number | null; mau: number | null }, month: string): Derived {
  const revenue = row.revenueUsd;
  const dau = row.avgDau;
  return {
    revenue,
    dau,
    downloads: row.downloads,
    arpdau: positive(dau) && revenue !== null ? revenue / (dau * daysInMonth(month)) : null,
    rpd: positive(row.downloads) && revenue !== null ? revenue / row.downloads : null,
    stickiness: positive(dau) && positive(row.mau) ? Math.min(1, dau / row.mau) : null,
  };
}

function hasData(row: MonthRow | undefined): boolean {
  return Boolean(row && (positive(row.revenueUsd) || positive(row.avgDau) || positive(row.downloads)));
}

function pickPrimary(monthly: Partial<Record<Country, MonthRow[]>>): Country {
  const recent = (rows: MonthRow[] | undefined) => (rows ?? []).slice(-3).some(hasData);
  return recent(monthly.CN) ? "CN" : "WW";
}

function scoreOf(weights: Record<string, number>, metrics: MetricScore[]): { score: number | null; coverage: number } {
  let sum = 0;
  let w = 0;
  let total = 0;
  for (const [key, weight] of Object.entries(weights)) {
    total += weight;
    const m = metrics.find((x) => x.key === key);
    if (!m || m.score === null) continue;
    sum += weight * m.score;
    w += weight;
  }
  return { score: w > 0 ? round(sum / w) : null, coverage: total > 0 ? w / total : 0 };
}

export async function buildMarketReport(info: StGameInfo): Promise<MarketReport> {
  const lastMonth = lastFullMonth();
  const [monthlyRaw, daily] = await Promise.all([
    stMonthlySeries(info.unifiedId, addMonths(lastMonth, -17), lastMonth),
    stDailySeries(info.unifiedId, daysAgo(120)),
  ]);
  const monthly: Partial<Record<Country, MonthRow[]>> = {};
  for (const [c, rows] of Object.entries(monthlyRaw) as Array<[Country, MonthRow[]]>) {
    const meaningful = rows.some((r) => (r.avgDau ?? 0) >= 1000 || positive(r.revenueUsd) || (r.downloads ?? 0) >= 1000);
    if (c !== "VN" || meaningful) monthly[c] = rows;
  }

  const primary = pickPrimary(monthly);
  const series = monthly[primary] ?? [];
  const pattern = matchPattern(info.taxonomy);
  const defs = frameworks().metrics;
  const notes: string[] = [];
  if (primary === "CN") notes.push("Số liệu CN của Sensor Tower chỉ gồm App Store — Trung Quốc không có Google Play nên Android TQ không được tính.");
  notes.push("Doanh thu là IAP ước tính của Sensor Tower (USD), không gồm doanh thu quảng cáo.");

  const countries: MarketReport["countries"] = {};
  for (const c of ["CN", "WW", "VN"] as Country[]) {
    if (!monthly[c] && !daily[c]) continue;
    countries[c] = { monthly: monthly[c] ?? [], daily: daily[c] ?? [] };
  }

  let idx = -1;
  for (let i = series.length - 1; i >= 0; i--) {
    if (hasData(series[i])) {
      idx = i;
      break;
    }
  }

  const base: Omit<MarketReport, "metrics" | "marketScore" | "confidence" | "benchmark"> = {
    unifiedId: info.unifiedId,
    name: info.name,
    publisher: info.publisher,
    iconUrl: info.iconUrl,
    taxonomy: info.taxonomy,
    releaseDates: info.releaseDates,
    primaryCountry: primary,
    lastFullMonth: lastMonth,
    countries,
    pattern,
    notes,
  };

  if (idx < 0) {
    notes.push("Sensor Tower chưa có số liệu doanh thu/DAU/lượt tải cho game này ở CN và WW (có thể chưa ra mắt hoặc chưa được theo dõi).");
    return { ...base, metrics: [], marketScore: null, confidence: "low", benchmark: null };
  }

  const month = series[idx].month;
  if (month !== lastMonth) notes.push(`Tháng gần nhất có số liệu là ${month.slice(0, 7)} (không phải ${lastMonth.slice(0, 7)}).`);
  const at = (offset: number) => series[idx + offset];
  const cur = derive(series[idx], month);
  const prior3 = [at(-3), at(-2), at(-1)].filter(Boolean) as MonthRow[];
  const last3 = [at(-2), at(-1), at(0)].filter(Boolean) as MonthRow[];
  const prev3 = [at(-5), at(-4), at(-3)].filter(Boolean) as MonthRow[];
  const last6 = [at(-5), at(-4), at(-3), at(-2), at(-1), at(0)].filter(Boolean) as MonthRow[];
  const history = series.slice(0, idx + 1).filter(hasData).length;
  if (history < 4) notes.push(`Game mới có ${history} tháng dữ liệu — các chỉ số xu hướng và độ ổn định có thể bị bỏ qua.`);

  let level: "subgenre" | "genre" = "subgenre";
  let group = info.subgenre;
  let cohort: CohortRow[] = group ? await stCohort(primary, month, "subgenre", group) : [];
  if (cohort.length < 8 && info.genre) {
    level = "genre";
    group = info.genre;
    cohort = await stCohort(primary, month, "genre", info.genre);
  }
  if (!cohort.some((r) => r.unifiedId === info.unifiedId)) {
    cohort.push({ unifiedId: info.unifiedId, name: info.name, ...series[idx] });
  }
  const cohortDerived = cohort.map((r) => derive(r, month));
  const values = (k: keyof Derived) => cohortDerived.map((d) => d[k]).filter((v): v is number => v !== null);

  const revenueAvg = (rows: MonthRow[]) => mean(rows.map((r) => r.revenueUsd).filter(positive));
  const last6Revenue = last6.map((r) => r.revenueUsd).filter(positive);
  const revMean = mean(last6Revenue);
  const sd = revMean !== null && last6Revenue.length >= 4 ? Math.sqrt(mean(last6Revenue.map((v) => (v - revMean) ** 2)) ?? 0) : null;

  const raw: Record<string, number | null> = {
    ...cur,
    dauTrend: growth(cur.dau, prior3.map((r) => r.avgDau)),
    revenueTrend: growth(cur.revenue, prior3.map((r) => r.revenueUsd)),
    downloadsTrend: growth(cur.downloads, prior3.map((r) => r.downloads)),
    revenueTrend6m: last3.length === 3 && prev3.length === 3 && positive(revenueAvg(prev3)) && revenueAvg(last3) !== null ? revenueAvg(last3)! / revenueAvg(prev3)! - 1 : null,
    revenueStability: sd !== null && revMean ? 1 - sd / revMean : null,
  };

  const metrics: MetricScore[] = Object.entries(defs).map(([key, def]) => {
    const value = raw[key] ?? null;
    let percentile: number | null = null;
    let score: number | null = null;
    let cohortMedian: number | null = null;
    if (def.kind === "percentile") {
      const arr = values(key as keyof Derived);
      cohortMedian = median(arr);
      if (value !== null) percentile = percentileOf(arr, value);
      score = percentile;
    } else if (def.kind === "growth") {
      if (value !== null) score = clamp(50 + value * 100);
    } else if (value !== null) {
      score = clamp(value * 100);
    }
    return {
      key,
      label: def.label,
      labelEn: def.labelEn,
      unit: def.unit,
      value: value === null ? null : round(value, def.unit === "usd" && Math.abs(value) < 100 ? 4 : 3),
      percentile: round(percentile),
      score: round(score),
      weight: pattern.weights[key] ?? 0,
      cohortMedian: cohortMedian === null ? null : round(cohortMedian, 4),
      note: value === null ? "Thiếu dữ liệu" : null,
    };
  });
  metrics.sort((a, b) => b.weight - a.weight);

  const { score, coverage } = scoreOf(pattern.weights, metrics);
  const confidence = coverage >= 0.8 && cohort.length >= 15 && history >= 6 ? "high" : coverage >= 0.5 && history >= 3 ? "medium" : "low";

  const rev = cur.revenue;
  const dau = cur.dau;
  const cohortRevenue = cohort.map((r) => r.revenueUsd ?? 0).reduce((a, b) => a + b, 0);
  const trend = level === "subgenre" && group ? await stSubgenreTrend(primary, group, addMonths(month, -11), month) : [];

  return {
    ...base,
    metrics,
    marketScore: score,
    confidence,
    benchmark: {
      country: primary,
      month,
      level,
      group,
      cohortSize: cohort.length,
      rankRevenue: rev !== null ? 1 + cohort.filter((r) => (r.revenueUsd ?? 0) > rev).length : null,
      rankDau: dau !== null ? 1 + cohort.filter((r) => (r.avgDau ?? 0) > dau).length : null,
      shareOfRevenue: rev !== null && cohortRevenue > 0 ? round((rev / cohortRevenue) * 100, 2) : null,
      top: [...cohort]
        .sort((a, b) => (b.revenueUsd ?? 0) - (a.revenueUsd ?? 0))
        .slice(0, 5)
        .map((r) => ({ unifiedId: r.unifiedId, name: r.name, revenueUsd: r.revenueUsd, avgDau: r.avgDau })),
      trend,
    },
  };
}

const logBand = (value: number | null, floorExp: number, span = 4) => (positive(value) ? clamp(((Math.log10(value) - floorExp) / span) * 100) : null);

function steamMetric(key: string, label: string, labelEn: string, unit: MetricScore["unit"], value: number | null, score: number | null, weight: number, note: string | null = null): MetricScore {
  return { key, label, labelEn, unit, value: round(value, unit === "ratio" || unit === "pct" ? 4 : 2), percentile: null, score: round(score), weight, cohortMedian: null, note: value === null ? "Thiếu dữ liệu" : note };
}

export async function buildSteamReport(info: SteamInfo): Promise<SteamReport> {
  const raw = await steamRaw(info, daysAgo(180));
  const ccu = raw.ccuDaily.map((d) => d.avg);
  const last30 = mean(ccu.slice(-30).filter((v): v is number => v !== null));
  const prev = mean(ccu.slice(-90, -30).filter((v): v is number => v !== null));
  const ccuTrend = last30 !== null && positive(prev) ? last30 / prev - 1 : null;
  const pct = raw.reviews?.positivePct ?? null;
  const reviewGain = raw.reviews?.total != null && raw.reviews.total30dAgo != null ? raw.reviews.total - raw.reviews.total30dAgo : null;
  const wishGain = raw.popularity?.wishlist != null && raw.popularity.wishlist4wAgo != null ? raw.popularity.wishlist - raw.popularity.wishlist4wAgo : null;

  const metrics: MetricScore[] = [
    steamMetric("ccu", "CCU trung bình 30 ngày", "Average CCU (30 days)", "count", last30, logBand(last30, 1), 0.3),
    steamMetric("ccuTrend", "Xu hướng CCU (30 ngày so với 60 ngày trước)", "CCU trend (30d vs prior 60d)", "pct", ccuTrend, ccuTrend === null ? null : clamp(50 + ccuTrend * 100), 0.15),
    steamMetric("positivePct", "Tỉ lệ review tích cực", "Positive review share", "ratio", pct === null ? null : pct / 100, pct === null ? null : clamp(((pct - 50) / 45) * 100), 0.2),
    steamMetric("reviews", "Tổng số review", "Total reviews", "count", raw.reviews?.total ?? null, logBand(raw.reviews?.total ?? null, 2), 0.15),
    steamMetric("followers", "Followers (VGI)", "Followers (VGI)", "count", raw.popularity?.followers ?? null, logBand(raw.popularity?.followers ?? null, 3), 0.1),
    steamMetric("unitsSold", "Bản bán ước tính (VGI)", "Estimated units sold (VGI)", "count", raw.sales?.unitsSold ?? null, logBand(raw.sales?.unitsSold ?? null, 4), 0.1),
    steamMetric("reviewGain30d", "Review mới trong 30 ngày", "New reviews (30 days)", "count", reviewGain, null, 0),
    steamMetric("wishlistGain4w", "Wishlist tăng trong 4 tuần", "Wishlist gain (4 weeks)", "count", wishGain, null, 0),
    steamMetric("playtime", "Giờ chơi trung bình", "Average playtime", "hours", raw.activeness?.avgPlaytimeHours ?? null, null, 0),
  ];
  const weights = Object.fromEntries(metrics.filter((m) => m.weight > 0).map((m) => [m.key, m.weight]));
  const { score } = scoreOf(weights, metrics);
  const notes = ["CCU lấy từ Steam API (dự phòng SteamCharts); followers, wishlist, bản bán và doanh thu là ước tính của VGI/PlayTracker."];
  if (!raw.ccuDaily.length) notes.push("Kho Steam chưa theo dõi CCU của game này (chỉ ~5.000 game được lấy CCU hằng giờ).");
  return { ...raw, metrics, steamScore: score, notes };
}
