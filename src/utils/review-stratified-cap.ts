/** Giới hạn review đưa vào LLM + lấy mẫu phân tầng (thời gian × sao). */

export interface ReviewForStratifiedCap {
  text: string;
  score: number;
  date: string;
  bucket: string;
}

export const RATING_BUCKET_LABELS = [
  "Very Negative",
  "Negative",
  "Mixed",
  "Positive",
  "Very Positive",
] as const;

export function intEnvCap(name: string, def: number): number {
  const v = process.env[name];
  if (v == null || v === "") return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

export const AI_MAX_REVIEWS_FOR_ANALYSIS = Math.max(
  500,
  intEnvCap("AI_MAX_REVIEWS_FOR_ANALYSIS", 10_000),
);

export const AI_STRATIFY_TIME_BUCKETS = Math.max(
  2,
  Math.min(24, intEnvCap("AI_STRATIFY_TIME_BUCKETS", 10)),
);

function parseYmd(date: string): number | null {
  if (!date || date === "unknown") return null;
  const t = new Date(`${date.slice(0, 10)}T12:00:00.000Z`).getTime();
  return Number.isNaN(t) ? null : t;
}

function timeBucketIndex(
  date: string,
  minMs: number,
  maxMs: number,
  bucketCount: number,
): number {
  const t = parseYmd(date);
  if (t == null) return bucketCount;
  if (maxMs <= minMs) return 0;
  const ratio = Math.min(1, Math.max(0, (t - minMs) / (maxMs - minMs)));
  return Math.min(bucketCount - 1, Math.floor(ratio * bucketCount));
}

function cellKey(timeIdx: number | "unknown", score: number): string {
  return `${timeIdx}-${score}`;
}

function allocatePerCellLimits(total: number, cellCount: number): number[] {
  if (cellCount <= 0) return [];
  const base = Math.floor(total / cellCount);
  let rem = total - base * cellCount;
  return Array.from({ length: cellCount }, () => {
    const extra = rem > 0 ? 1 : 0;
    if (extra) rem -= 1;
    return base + extra;
  });
}

/** Lấy mẫu đều trong mảng (giữ phủ từ đầu đến cuối khoảng). */
export function sampleEvenly<T>(items: T[], take: number): T[] {
  if (items.length <= take) return items;
  if (take <= 0) return [];
  const out: T[] = [];
  for (let i = 0; i < take; i++) {
    const idx = Math.min(items.length - 1, Math.floor((i + 0.5) * items.length / take));
    out.push(items[idx]!);
  }
  return out;
}

function groupByStratifiedCells(
  reviews: ReviewForStratifiedCap[],
  timeBucketCount: number,
): Map<string, ReviewForStratifiedCap[]> {
  const dated = reviews.filter((r) => parseYmd(r.date) != null);
  let minMs = Number.POSITIVE_INFINITY;
  let maxMs = Number.NEGATIVE_INFINITY;
  for (const r of dated) {
    const t = parseYmd(r.date)!;
    if (t < minMs) minMs = t;
    if (t > maxMs) maxMs = t;
  }
  if (!Number.isFinite(minMs)) {
    minMs = 0;
    maxMs = 0;
  }

  const groups = new Map<string, ReviewForStratifiedCap[]>();
  const push = (key: string, r: ReviewForStratifiedCap) => {
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  };

  for (const r of reviews) {
    const score =
      r.score >= 1 && r.score <= 5 ? r.score : Math.round(Number(r.score)) || 0;
    if (score < 1 || score > 5) continue;
    const t = parseYmd(r.date);
    if (t == null) {
      push(cellKey("unknown", score), r);
      continue;
    }
    const tb = timeBucketIndex(r.date, minMs, maxMs, timeBucketCount);
    push(cellKey(tb, score), r);
  }

  for (const list of groups.values()) {
    list.sort((a, b) => {
      if (a.date === b.date) return 0;
      if (a.date === "unknown") return 1;
      if (b.date === "unknown") return -1;
      return b.date.localeCompare(a.date);
    });
  }

  return groups;
}

export type StratifiedCapResult<T extends ReviewForStratifiedCap> = {
  reviews: T[];
  totalBeforeCap: number;
  capped: boolean;
};

/** Phân tầng theo khung thời gian + sao 1–5, tối đa `max` review. */
export function capStratifiedReviews<T extends ReviewForStratifiedCap>(
  reviews: T[],
  max: number = AI_MAX_REVIEWS_FOR_ANALYSIS,
  timeBucketCount: number = AI_STRATIFY_TIME_BUCKETS,
): StratifiedCapResult<T> {
  const totalBeforeCap = reviews.length;
  if (reviews.length <= max) {
    return { reviews, totalBeforeCap, capped: false };
  }

  const groups = groupByStratifiedCells(reviews, timeBucketCount);
  const keys = [...groups.keys()].filter((k) => (groups.get(k)?.length ?? 0) > 0);
  const limits = allocatePerCellLimits(max, keys.length);

  const out: T[] = [];
  keys.forEach((key, i) => {
    const list = groups.get(key)! as T[];
    out.push(...sampleEvenly(list, limits[i] ?? 0));
  });

  out.sort((a, b) => {
    if (a.date === "unknown" && b.date === "unknown") return 0;
    if (a.date === "unknown") return 1;
    if (b.date === "unknown") return -1;
    return b.date.localeCompare(a.date);
  });

  return { reviews: out, totalBeforeCap, capped: true };
}

export function buildTimeSlices(
  min: Date,
  max: Date,
  bucketCount: number,
): Array<{ start: Date; end: Date }> {
  const minMs = min.getTime();
  const maxMs = max.getTime();
  if (maxMs <= minMs) return [{ start: min, end: new Date(maxMs + 86_400_000) }];
  const span = (maxMs - minMs) / bucketCount;
  const slices: Array<{ start: Date; end: Date }> = [];
  for (let i = 0; i < bucketCount; i++) {
    const start = new Date(minMs + span * i);
    const end =
      i === bucketCount - 1
        ? new Date(maxMs + 86_400_000)
        : new Date(minMs + span * (i + 1));
    slices.push({ start, end });
  }
  return slices;
}

export function allocateStratifiedCellLimits(
  max: number,
  timeBucketCount: number,
  includeUnknownTime: boolean,
): { perCell: number; cellCount: number } {
  const cellCount = timeBucketCount * 5 + (includeUnknownTime ? 5 : 0);
  const perCell = Math.max(1, Math.ceil(max / Math.max(1, cellCount)));
  return { perCell, cellCount };
}
