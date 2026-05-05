import crypto from "crypto";

const BASE_URL = "https://www.taptap.cn/webapiv2";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

function buildXUA(platform: "android" | "ios" = "android"): string {
  const ds = platform === "ios" ? "iOS" : "Android";
  return `V=1&PN=WebApp&LANG=zh_CN&VN_CODE=102&LOC=CN&PLT=PC&DS=${ds}&UID=${crypto.randomUUID()}&OS=Windows&OSV=10&DT=PC`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function parseAppIdFromInput(input: string): number | null {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  const match = trimmed.match(/\/app\/(\d+)/);
  if (match) return parseInt(match[1], 10);
  return null;
}

interface TapTapAppInfo {
  title: string;
  iconUrl: string | null;
  rating: string | null;
  fansCount: number | null;
  reserveCount: number | null;
}

export interface ExternalReview {
  text: string;
  score: number;
  date: string;
  bucket: string;
}

const RATING_BUCKETS = [
  { label: "Very Negative", min: 1, max: 1 },
  { label: "Negative", min: 2, max: 2 },
  { label: "Mixed", min: 3, max: 3 },
  { label: "Positive", min: 4, max: 4 },
  { label: "Very Positive", min: 5, max: 5 },
] as const;

const PAGE_SIZE = 10;
const CONCURRENT_PAGES = 15;
const BATCH_DELAY_MS = 400;
const MAX_OFFSET = 9900;  // TapTap caps `from` at ~10000

async function taptapGet(path: string, params: Record<string, string | number>): Promise<unknown> {
  const xua = buildXUA();
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  qs.set("X-UA", xua);

  const url = `${BASE_URL}/${path}?${qs.toString()}`;

  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
  });

  if (!res.ok) {
    let body = "";
    try { body = await res.text(); } catch { /* ignore */ }
    console.error(`[taptap-client] ${res.status} ${res.statusText} — body: ${body.slice(0, 300)}`);
    throw new Error(`TapTap API ${res.status}: ${res.statusText}`);
  }

  const json = (await res.json()) as { success?: boolean; data?: unknown };
  if (!json.data) throw new Error("TapTap API returned no data");
  return json.data;
}

export async function fetchAppInfo(appId: number): Promise<TapTapAppInfo> {
  const data = (await taptapGet("app/v4/detail", { id: appId })) as Record<string, unknown>;

  const icon = data.icon as Record<string, string> | undefined;
  const stat = data.stat as Record<string, unknown> | undefined;
  const rating = stat?.rating as Record<string, unknown> | undefined;

  return {
    title: (data.title as string) ?? `App #${appId}`,
    iconUrl: icon?.url ?? icon?.medium_url ?? null,
    rating: (rating?.score as string) ?? null,
    fansCount: (stat?.fans_count as number) ?? null,
    reserveCount: (stat?.reserve_count as number) ?? null,
  };
}

/**
 * Full JSON payload from app/v4/detail — used for tags / haystack in external URL analysis.
 * Same endpoint as fetchAppInfo; call when you need genre tags without duplicating logic.
 */
export async function fetchAppDetailRaw(appId: number): Promise<Record<string, unknown> | null> {
  try {
    const data = (await taptapGet("app/v4/detail", { id: appId })) as Record<string, unknown>;
    return data && typeof data === "object" ? data : null;
  } catch (e) {
    console.warn(`[taptap-client] fetchAppDetailRaw(${appId}) failed:`, e instanceof Error ? e.message : e);
    return null;
  }
}

function looksLikeTapTapAppDetail(obj: unknown): obj is Record<string, unknown> {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const o = obj as Record<string, unknown>;
  if (Array.isArray(o.information)) return true;
  if (typeof o.title === "string" && o.title.length > 0 && (o.stat != null || Array.isArray(o.tags))) return true;
  return false;
}

/**
 * Phản hồi proxy `/api/full/:id` có thể kèm snapshot app/v4/detail dưới nhiều tên field — gom một object dùng cho extractTags / extractDeveloperPublisher.
 */
export function pickTapTapDetailFromProxyBundle(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const nestedKeys = ["detailRaw", "appDetail", "detail", "app_v4", "taptapDetail", "raw", "fullApp", "app"];
  for (const k of nestedKeys) {
    const v = root[k];
    if (looksLikeTapTapAppDetail(v)) return v;
  }
  if (looksLikeTapTapAppDetail(root)) return root;
  const inner: unknown = root["data"];
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    const innerObj = inner as Record<string, unknown>;
    for (const k of nestedKeys) {
      const v = innerObj[k];
      if (looksLikeTapTapAppDetail(v)) return v;
    }
  }
  return null;
}

interface PageResult {
  list: Array<Record<string, unknown>>;
  nextPage: boolean;
  total: number;
}

async function fetchPage(appId: number, from: number): Promise<PageResult | null> {
  try {
    const data = (await taptapGet("review/v2/list-by-app", {
      app_id: appId,
      sort: "new",
      from,
      limit: PAGE_SIZE,
    })) as Record<string, unknown>;

    return {
      list: (data.list as Array<Record<string, unknown>>) ?? [],
      nextPage: !!data.next_page,
      total: (data.total as number) ?? 0,
    };
  } catch {
    return null;
  }
}

function extractReview(item: Record<string, unknown>): ExternalReview | null {
  if (item.type !== "moment") return null;

  const moment = item.moment as Record<string, unknown> | undefined;
  if (!moment) return null;

  const review = moment.review as Record<string, unknown> | undefined;
  const contents = review?.contents as Record<string, unknown> | undefined;
  const text =
    (contents?.text as string) ??
    ((moment.sharing as Record<string, unknown>)?.description as string) ??
    "";
  if (text.length < 5) return null;

  const score = Math.round(Number(review?.score ?? 0));
  if (score < 1 || score > 5) return null;

  const bucket = RATING_BUCKETS.find((b) => score >= b.min && score <= b.max);
  if (!bucket) return null;

  const publishTime = moment.publish_time as number | undefined;
  const date = publishTime
    ? new Date(publishTime * 1000).toISOString().slice(0, 10)
    : "unknown";

  return { text, score, date, bucket: bucket.label };
}

export async function fetchExternalReviews(appId: number): Promise<ExternalReview[]> {
  const allReviews: ExternalReview[] = [];
  const bucketCounts = new Map<string, number>();
  for (const b of RATING_BUCKETS) bucketCounts.set(b.label, 0);

  let from = 0;
  let totalScanned = 0;
  let apiTotal = Infinity;
  let reachedEnd = false;
  const startTime = Date.now();

  while (!reachedEnd) {
    const offsets = [];
    for (let i = 0; i < CONCURRENT_PAGES; i++) {
      const off = from + i * PAGE_SIZE;
      if (off < apiTotal && off <= MAX_OFFSET) offsets.push(off);
    }
    if (offsets.length === 0) break;

    const results = await Promise.all(offsets.map((off) => fetchPage(appId, off)));

    let anyData = false;
    for (const result of results) {
      if (!result || result.list.length === 0) {
        reachedEnd = true;
        continue;
      }
      anyData = true;
      apiTotal = result.total;
      if (!result.nextPage) reachedEnd = true;

      for (const item of result.list) {
        const rev = extractReview(item);
        if (rev) {
          allReviews.push(rev);
          bucketCounts.set(rev.bucket, (bucketCounts.get(rev.bucket) ?? 0) + 1);
        }
      }

      totalScanned += result.list.length;
    }

    if (!anyData) break;

    from += offsets.length * PAGE_SIZE;

    if (totalScanned % 500 === 0 || totalScanned >= apiTotal) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(
        `[taptap-client] appId=${appId}: scanned ${totalScanned}/${apiTotal}, ` +
        `collected ${allReviews.length} (${elapsed}s) — ` +
        RATING_BUCKETS.map((b) => `${b.min}★=${bucketCounts.get(b.label) ?? 0}`).join(" ")
      );
    }

    await sleep(BATCH_DELAY_MS);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `[taptap-client] appId=${appId}: DONE — ${allReviews.length} reviews from ${totalScanned} scanned in ${elapsed}s. ` +
    RATING_BUCKETS.map((b) => `${b.label}=${bucketCounts.get(b.label) ?? 0}`).join(", ")
  );

  return allReviews;
}
