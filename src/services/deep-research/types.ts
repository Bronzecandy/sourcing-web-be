export type MapStatus = "auto" | "confirmed" | "none" | "unmapped";
export type Country = "CN" | "WW" | "VN";

export interface StRef {
  unifiedId: string;
  name: string;
  publisher: string | null;
  iconUrl: string | null;
  gameClass: string | null;
  genre: string | null;
  subgenre: string | null;
  releaseDate: string | null;
}

export interface SteamRef {
  steamAppId: number;
  name: string;
  developers: string[];
  publishers: string[];
  releaseDate: string | null;
  headerImage: string | null;
}

export interface GameIdentity {
  internationalNames: string[];
  otherNames: string[];
  developerEn: string | null;
  publisherEn: string | null;
  steamAppId: number | null;
  released: "cn" | "global" | "both" | "unreleased" | "unknown";
  note: string | null;
  grounded: boolean;
  queries: string[];
  sources: string[];
  at: string;
}

export interface MappingDto {
  appId: number;
  title: string;
  st: { status: MapStatus; method: string | null; ref: StRef | null };
  steam: { status: MapStatus; method: string | null; ref: SteamRef | null };
  identity: GameIdentity | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  checkedAt: string | null;
}

export interface MonthSnapshot {
  country: Country;
  month: string;
  revenueUsd: number | null;
  avgDau: number | null;
  downloads: number | null;
  mau: number | null;
}

export interface StCandidate extends StRef {
  score: number;
  reasons: string[];
  lastMonth: MonthSnapshot | null;
}

export interface SteamCandidate extends SteamRef {
  score: number;
  reasons: string[];
  reviews: number | null;
  positivePct: number | null;
}

export interface Candidates {
  st: StCandidate[];
  steam: SteamCandidate[];
  searched: string[];
}

export type MetricUnit = "usd" | "count" | "ratio" | "pct" | "hours";

export interface MetricScore {
  key: string;
  label: string;
  labelEn: string;
  unit: MetricUnit;
  value: number | null;
  /** Percentile 0–100 within the benchmark cohort (null when scored by bands). */
  percentile: number | null;
  score: number | null;
  weight: number;
  cohortMedian: number | null;
  note: string | null;
}

export interface FrameworkPattern {
  key: string;
  label: string;
  labelEn: string;
  summary: string;
  summaryEn: string;
  watch: string[];
  watchEn: string[];
  weights: Record<string, number>;
  match: { subgenres?: string[]; genres?: string[]; classes?: string[] };
}

export interface MarketSeries {
  monthly: Array<{ month: string; revenueUsd: number | null; avgDau: number | null; downloads: number | null; mau: number | null }>;
  daily: Array<{ date: string; revenueUsd: number | null; dau: number | null; downloads: number | null }>;
}

export interface MarketReport {
  unifiedId: string;
  name: string;
  publisher: string | null;
  iconUrl: string | null;
  taxonomy: Record<string, string | null>;
  releaseDates: { earliest: string | null; ww: string | null; cn: string | null };
  primaryCountry: Country;
  lastFullMonth: string;
  countries: Partial<Record<Country, MarketSeries>>;
  pattern: FrameworkPattern;
  metrics: MetricScore[];
  marketScore: number | null;
  confidence: "high" | "medium" | "low";
  benchmark: {
    country: Country;
    month: string;
    level: "subgenre" | "genre";
    group: string | null;
    cohortSize: number;
    rankRevenue: number | null;
    rankDau: number | null;
    shareOfRevenue: number | null;
    top: Array<{ unifiedId: string; name: string; revenueUsd: number | null; avgDau: number | null }>;
    trend: Array<{ month: string; revenueUsd: number | null; avgDau: number | null; downloads: number | null }>;
  } | null;
  notes: string[];
}

export interface SteamReport {
  ref: SteamRef;
  tags: string[];
  isFree: boolean | null;
  priceUsd: number | null;
  ccuDaily: Array<{ date: string; avg: number | null; max: number | null }>;
  reviews: { total: number | null; positive: number | null; positivePct: number | null; label: string | null; total30dAgo: number | null; observedAt: string } | null;
  popularity: { followers: number | null; wishlist: number | null; followers4wAgo: number | null; wishlist4wAgo: number | null; observedAt: string } | null;
  sales: { unitsSold: number | null; revenueUsd: number | null; observedAt: string } | null;
  activeness: { playersTotal: number | null; activePlayers: number | null; avgPlaytimeHours: number | null; observedAt: string } | null;
  ranks: Array<{ name: string; scope: string; value: number; date: string }>;
  metrics: MetricScore[];
  steamScore: number | null;
  notes: string[];
}

export type FindingCategory = "performance" | "launch" | "reception" | "company_financial" | "company_news" | "risk";

export interface WebFinding {
  id: string;
  subject: "game" | "company";
  category: FindingCategory;
  claim: string;
  date: string;
  url: string;
  sentiment: "positive" | "neutral" | "negative";
}

export interface WebReport {
  grounded: boolean;
  queries: string[];
  findings: WebFinding[];
  errors: string[];
}

export type Verdict = "strong" | "promising" | "watch" | "weak" | "insufficient";

export interface SynthesisDto {
  verdict: Verdict;
  headline: string;
  patternRead: string;
  insights: Array<{ text: string; refs: string[] }>;
  risks: Array<{ text: string; refs: string[] }>;
  opportunities: Array<{ text: string; refs: string[] }>;
  verify: Array<{ question: string; why: string }>;
  nextStep: string;
  model: string;
}

export interface TapTapSnapshot {
  title: string;
  iconUrl: string | null;
  developers: Array<{ name: string; type: string | null }>;
  releaseDate: string | null;
  tags: string[];
  rating: string | null;
  fans: number | null;
  reserveCount: number | null;
  downloadCount: number | null;
  storeIds: { itunes: string | null; android: string | null };
  potential: {
    segment: string;
    days: number;
    platform: string;
    compositeScore: number | null;
    momentumScore: number | null;
    audienceScore: number | null;
    ratingScore: number | null;
    rankQualityScore: number | null;
    currentRank: number | null;
    trend: string | null;
    audienceGrowthRate: number | null;
  } | null;
}

export type RunStatus = "queued" | "running" | "needs_mapping" | "done" | "failed";
export type StageKey = "identify" | "mapping" | "market" | "steam" | "web" | "synthesis";
export interface StageState {
  key: StageKey;
  status: "pending" | "running" | "done" | "skipped" | "failed";
  note: string | null;
}

export interface RunContext {
  days: number;
  platform: "combined" | "android" | "ios";
  segment: "reserve" | "launched";
}

export interface RunListItem {
  id: string;
  appId: number;
  title: string;
  iconUrl: string | null;
  status: RunStatus;
  verdict: Verdict | null;
  marketScore: number | null;
  createdByName: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface RunDto extends RunListItem {
  stage: StageKey | null;
  stages: StageState[];
  context: RunContext | null;
  error: string | null;
  startedAt: string | null;
  taptap: TapTapSnapshot | null;
  mapping: MappingDto | null;
  candidates: Candidates | null;
  market: MarketReport | null;
  steam: SteamReport | null;
  web: WebReport | null;
  summary: SynthesisDto | null;
}
