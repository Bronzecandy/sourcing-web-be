/**
 * Distribution-calibrated scoring for the Potential formula.
 *
 * Uses fixed tier points from Distribution bucket definitions (not percentile rank)
 * so large games keep a high base and slow growth is not over-penalized.
 */
import type {
  DistributionBucket,
  DistributionGrowthBucket,
  DistributionTab,
  BucketDefinition,
} from "../types";

type ScoreFn = (value: number | null | undefined) => number | null;

export interface TierLookupResult {
  points: number;
  label: string;
}

export interface LifecycleScorers {
  scaleAbs: ScoreFn;
  scaleGrowth: ScoreFn;
  ratingAbs: ScoreFn;
  ratingGrowth: ScoreFn;
}

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

// Potential scale buckets (extends Distribution COUNT_BUCKETS with finer top tiers).
const COUNT_BUCKET_DEFS: BucketDefinition[] = [
  { label: "0", min: 0, max: 0 },
  { label: "1–10K", min: 1, max: 10_000 },
  { label: "10K–50K", min: 10_001, max: 50_000 },
  { label: "50K–100K", min: 50_001, max: 100_000 },
  { label: "100K–500K", min: 100_001, max: 500_000 },
  { label: "500K–1M", min: 500_001, max: 1_000_000 },
  { label: "1M–2M", min: 1_000_001, max: 2_000_000 },
  { label: "2M–3M", min: 2_000_001, max: 3_000_000 },
  { label: "3M+", min: 3_000_001, max: null },
];

/** Log-scale anchor points for smooth base-value interpolation (value → points). */
const SCALE_ANCHORS: Array<{ value: number; points: number }> = [
  { value: 0, points: 8 },
  { value: 1, points: 22 },
  { value: 10_001, points: 38 },
  { value: 50_001, points: 52 },
  { value: 100_001, points: 52 },
  { value: 500_000, points: 68 },
  { value: 1_000_000, points: 80 },
  { value: 2_000_000, points: 94 },
  { value: 3_000_000, points: 98 },
  { value: 10_000_000, points: 100 },
];

function interpolateLogScale(value: number): number {
  if (value <= 0) return 8;
  const anchors = SCALE_ANCHORS;
  if (value >= anchors[anchors.length - 1]!.value) {
    return anchors[anchors.length - 1]!.points;
  }
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i]!;
    const b = anchors[i + 1]!;
    if (value < a.value) continue;
    if (value > b.value) continue;
    if (a.value === b.value) return b.points;
    if (a.value <= 1 || b.value <= 1) {
      const t = (value - a.value) / (b.value - a.value);
      return clamp(a.points + t * (b.points - a.points));
    }
    const logA = Math.log(a.value);
    const logB = Math.log(b.value);
    const logV = Math.log(Math.max(value, 1));
    const t = (logV - logA) / (logB - logA);
    return clamp(a.points + t * (b.points - a.points));
  }
  return 8;
}

// Mirrors COUNT_GROWTH_BUCKETS in distribution.service.ts
const GROWTH_BUCKET_DEFS: BucketDefinition[] = [
  { label: "≤ -100K", min: -9_000_000_000, max: -100_000 },
  { label: "-100K ~ -50K", min: -100_000, max: -50_001 },
  { label: "-50K ~ -20K", min: -50_000, max: -20_001 },
  { label: "-20K ~ -10K", min: -20_000, max: -10_001 },
  { label: "-10K ~ -5K", min: -10_000, max: -5_001 },
  { label: "-5K ~ 0", min: -5_000, max: -1 },
  { label: "Không đổi", min: 0, max: 0 },
  { label: "+1 ~ +5K", min: 1, max: 5_000 },
  { label: "+5K ~ +10K", min: 5_001, max: 10_000 },
  { label: "+10K ~ +20K", min: 10_001, max: 20_000 },
  { label: "+20K ~ +50K", min: 20_001, max: 50_000 },
  { label: "+50K ~ +100K", min: 50_001, max: 100_000 },
  { label: "+100K+", min: 100_001, max: null },
];

/** Additive growth bonus/penalty per bucket (roughly −20 … +22). */
const GROWTH_TIER_BONUS = [-20, -16, -12, -8, -5, -2, 0, 6, 10, 14, 18, 22, 28];

function findBucket(
  value: number,
  buckets: BucketDefinition[],
): { bucket: BucketDefinition; index: number } | null {
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i]!;
    const inRange = b.max == null ? value >= b.min : value >= b.min && value <= b.max;
    if (inRange) return { bucket: b, index: i };
  }
  return null;
}

function tierFromDefs(
  value: number,
  defs: BucketDefinition[],
  points: number[],
  fallback: TierLookupResult,
): TierLookupResult {
  const hit = findBucket(value, defs);
  if (!hit) return fallback;
  return { points: points[hit.index] ?? fallback.points, label: hit.bucket.label };
}

/** Absolute reserve/download tier → base value points (log-interpolated within bucket). */
export function tierAbsScale(value: number | null | undefined): TierLookupResult | null {
  if (value == null || value < 0) return null;
  const hit = findBucket(value, COUNT_BUCKET_DEFS);
  const points = Math.round(interpolateLogScale(value) * 10) / 10;
  return { points, label: hit?.bucket.label ?? "0" };
}

/** Growth delta tier → additive bonus (negative = penalty). */
export function tierGrowthDelta(delta: number | null | undefined): TierLookupResult | null {
  if (delta == null) return null;
  return tierFromDefs(delta, GROWTH_BUCKET_DEFS, GROWTH_TIER_BONUS, { points: 0, label: "Không đổi" });
}

/**
 * Rating base from period-start level: 8★→60, 10★→90 (linear from 5★).
 * Stable high ratings keep a high score without a separate "change" penalty.
 */
export function ratingStartBase(start: number): number {
  return clamp((start - 5) * 15 + 15);
}

/** ±5 points per 0.1 rating change in the window. */
export function ratingDeltaAdjustment(delta: number): number {
  return (delta / 0.1) * 5;
}

/**
 * Merged audience score: base tier + growth bonus.
 * Large base dampens how much growth (or slow growth) moves the final score.
 */
export function mergeAudienceScore(baseValue: number, growthBonus: number): {
  score: number;
  growthWeight: number;
} {
  const growthWeight = 0.25 + 0.75 * (1 - baseValue / 100);
  const score = clamp(baseValue + growthBonus * growthWeight);
  return { score, growthWeight: Math.round(growthWeight * 1000) / 1000 };
}

// ----------------------------------------------------------------------------
// Legacy percentile scorers (kept for optional diagnostics / warm-up)
// ----------------------------------------------------------------------------

function fallbackCountAbs(v: number): number {
  return tierAbsScale(v)?.points ?? 8;
}

function fallbackCountGrowth(d: number): number {
  const bonus = tierGrowthDelta(d)?.points ?? 0;
  return clamp(50 + bonus);
}

function fallbackRatingAbs(v: number): number {
  return clamp((v - 5) * 20);
}

function fallbackRatingGrowth(d: number): number {
  return clamp(50 + ratingDeltaAdjustment(d));
}

const FALLBACK: LifecycleScorers = {
  scaleAbs: (v) => (v == null ? null : fallbackCountAbs(v)),
  scaleGrowth: (d) => (d == null ? null : fallbackCountGrowth(d)),
  ratingAbs: (v) => (v == null ? null : fallbackRatingAbs(v)),
  ratingGrowth: (d) => (d == null ? null : fallbackRatingGrowth(d)),
};

interface CumEntry {
  min: number;
  max: number | null;
  count: number;
  below: number;
}

function buildCumulative(
  buckets: Array<{ min: number; max: number | null; count: number }>,
): { total: number; entries: CumEntry[] } {
  let cum = 0;
  const entries: CumEntry[] = [];
  for (const b of buckets) {
    entries.push({ min: b.min, max: b.max, count: b.count, below: cum });
    cum += b.count;
  }
  return { total: cum, entries };
}

function percentileScorer(
  buckets: Array<{ min: number; max: number | null; count: number }>,
  fallback: (v: number) => number,
): (v: number) => number {
  const { total, entries } = buildCumulative(buckets);
  if (total <= 0 || entries.length === 0) return fallback;
  const first = entries[0]!;
  return (v: number) => {
    for (const b of entries) {
      const inRange = b.max == null ? v >= b.min : v >= b.min && v <= b.max;
      if (inRange) {
        return clamp(((b.below + b.count / 2) / total) * 100);
      }
    }
    return v < first.min ? 0 : 100;
  };
}

function scorersFromBlocks(
  scaleAbsBuckets: DistributionBucket[] | undefined,
  scaleGrowthBuckets: DistributionGrowthBucket[] | undefined,
  ratingAbsBuckets: DistributionBucket[] | undefined,
  ratingGrowthBuckets: DistributionGrowthBucket[] | undefined,
): LifecycleScorers {
  const scaleAbsFn = scaleAbsBuckets
    ? percentileScorer(scaleAbsBuckets, fallbackCountAbs)
    : fallbackCountAbs;
  const scaleGrowthFn = scaleGrowthBuckets
    ? percentileScorer(scaleGrowthBuckets, fallbackCountGrowth)
    : fallbackCountGrowth;
  const ratingAbsFn = ratingAbsBuckets
    ? percentileScorer(ratingAbsBuckets, fallbackRatingAbs)
    : fallbackRatingAbs;
  const ratingGrowthFn = ratingGrowthBuckets
    ? percentileScorer(ratingGrowthBuckets, fallbackRatingGrowth)
    : fallbackRatingGrowth;
  return {
    scaleAbs: (v) => (v == null ? null : scaleAbsFn(v)),
    scaleGrowth: (d) => (d == null ? null : scaleGrowthFn(d)),
    ratingAbs: (v) => (v == null ? null : ratingAbsFn(v)),
    ratingGrowth: (d) => (d == null ? null : ratingGrowthFn(d)),
  };
}

const LIFECYCLES: DistributionTab[] = ["reserve", "new", "old"];
const SCALE_METRIC: Record<DistributionTab, "reserve" | "download"> = {
  reserve: "reserve",
  new: "download",
  old: "download",
};

const REFRESH_TTL_MS = Math.max(
  60_000,
  parseInt(process.env.POTENTIAL_SCORER_TTL_MS ?? "21600000", 10) || 21_600_000,
);

const cache = new Map<DistributionTab, LifecycleScorers>();
let lastBuiltAt = 0;
let buildInFlight: Promise<void> | null = null;

async function buildLifecycle(lifecycle: DistributionTab): Promise<LifecycleScorers> {
  const { distributionService } = await import("../services/distribution.service");
  try {
    const overview = await distributionService.getOverview({ year: null, lifecycle });
    const scaleMetric = SCALE_METRIC[lifecycle];
    const scaleBlock = overview.metrics.find((m) => m.metric === scaleMetric);
    const ratingBlock = overview.metrics.find((m) => m.metric === "rating");
    return scorersFromBlocks(
      scaleBlock?.absoluteBuckets,
      scaleBlock?.growthBuckets,
      ratingBlock?.absoluteBuckets,
      ratingBlock?.growthBuckets,
    );
  } catch (err) {
    console.warn(
      `[potential-scorer] failed to build ${lifecycle} distribution scorers, using fallback:`,
      err instanceof Error ? err.message : err,
    );
    return FALLBACK;
  }
}

async function rebuildAll(): Promise<void> {
  for (const lifecycle of LIFECYCLES) {
    cache.set(lifecycle, await buildLifecycle(lifecycle));
  }
  lastBuiltAt = Date.now();
}

export async function ensurePotentialScorers(force = false): Promise<void> {
  const stale = Date.now() - lastBuiltAt > REFRESH_TTL_MS;
  if (!force && cache.size === LIFECYCLES.length && !stale) return;
  if (buildInFlight) return buildInFlight;
  buildInFlight = rebuildAll().finally(() => {
    buildInFlight = null;
  });
  return buildInFlight;
}

export function getScorers(lifecycle: DistributionTab): LifecycleScorers {
  return cache.get(lifecycle) ?? FALLBACK;
}

export async function refreshPotentialScorers(): Promise<void> {
  await ensurePotentialScorers(true);
}
