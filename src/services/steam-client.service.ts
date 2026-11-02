/**
 * Steam public APIs (no Steamworks key): appdetails cho metadata,
 * IUserReviewsService/GetAppReviews cho review. Endpoint cũ
 * store.steampowered.com/appreviews bị tắt 22/10/2026 (302 về trang chủ HTML).
 * @see https://partner.steamgames.com/doc/webapi/IUserReviewsService
 */

import type { ExternalReview } from "./taptap-client.service";

const STEAM_STORE_BASE = "https://store.steampowered.com";
const STEAM_REVIEWS_API = "https://api.steampowered.com/IUserReviewsService/GetAppReviews/v1/";
const USER_AGENT =
  process.env.STEAM_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

function intEnv(name: string, def: number): number {
  const v = process.env[name];
  if (v == null || v === "") return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

/** Delay between cursor pages (ms); tune vs TapTap BATCH_DELAY_MS (~400). */
const PAGE_DELAY_MS = Math.max(0, intEnv("STEAM_REVIEW_PAGE_DELAY_MS", 350));
const MAX_REVIEWS_CAP = Math.min(100_000, Math.max(100, intEnv("STEAM_MAX_REVIEWS", 10_000)));
const NUM_PER_PAGE = 100;
const FETCH_RETRIES = 4;
const RETRY_BASE_MS = 800;

const RATING_BUCKETS = [
  { label: "Very Negative", min: 1, max: 1 },
  { label: "Negative", min: 2, max: 2 },
  { label: "Mixed", min: 3, max: 3 },
  { label: "Positive", min: 4, max: 4 },
  { label: "Very Positive", min: 5, max: 5 },
] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** URL hoặc App ID thuần (vd https://store.steampowered.com/app/3242950/...) */
export function parseSteamAppIdFromInput(input: string): number | null {
  const trimmed = input.trim();
  const fromUrl = trimmed.match(/store\.steampowered\.com\/app\/(\d+)/i);
  if (fromUrl) return parseInt(fromUrl[1], 10);
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  return null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Trang HTML (redirect, age gate) không phải lỗi tạm thời — thử lại cũng ra HTML. */
class SteamHtmlResponseError extends Error {}

async function fetchJsonWithRetry(url: string): Promise<unknown> {
  let lastErr = "";
  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        redirect: "follow",
      });
      const body = await res.text();
      if (body.trimStart().startsWith("<")) {
        throw new SteamHtmlResponseError(`Steam trả về HTML (HTTP ${res.status}) thay vì JSON`);
      }
      if (res.ok) return JSON.parse(body) as unknown;
      lastErr = `HTTP ${res.status}: ${body.slice(0, 400)}`;
      const backoff = RETRY_BASE_MS * Math.pow(2, attempt - 1) * (res.status === 403 || res.status === 429 ? 3 : 1);
      await sleep(backoff);
    } catch (e) {
      if (e instanceof SteamHtmlResponseError) throw e;
      lastErr = e instanceof Error ? e.message : String(e);
      await sleep(RETRY_BASE_MS * Math.pow(2, attempt - 1));
    }
  }
  throw new Error(`Steam fetch failed after retries: ${lastErr}`);
}

/** Chi tiết app từ Store Web API — dùng cho title/dev/tag/header. */
export async function fetchSteamAppDetails(appId: number): Promise<Record<string, unknown> | null> {
  const url = `${STEAM_STORE_BASE}/api/appdetails?appids=${appId}&l=english`;
  const json = (await fetchJsonWithRetry(url)) as Record<string, unknown>;
  const entry = json[String(appId)] as Record<string, unknown> | undefined;
  if (!entry || entry.success !== true) return null;
  const data = entry.data as Record<string, unknown> | undefined;
  return data && typeof data === "object" ? data : null;
}

/**
 * Shape gần TapTap raw để extractTags / extractDeveloperPublisher / buildSearchHaystack dùng được.
 */
export function buildSteamDetailRaw(appData: Record<string, unknown>, steamAppId: number): Record<string, unknown> {
  const genres =
    (appData.genres as Array<{ description?: string }> | undefined)
      ?.map((g) => g.description)
      .filter((x): x is string => !!x && x.trim().length > 0) ?? [];
  const categories =
    (appData.categories as Array<{ description?: string }> | undefined)
      ?.map((c) => c.description)
      .filter((x): x is string => !!x && x.trim().length > 0) ?? [];

  const tagValues = [...genres, ...categories];
  const tags = tagValues.slice(0, 48).map((value, i) => ({ id: i + 1, value }));

  const developers = appData.developers as string[] | undefined;
  const publishers = appData.publishers as string[] | undefined;
  const headerImage = typeof appData.header_image === "string" ? appData.header_image : null;
  const shortDesc = stripHtml(String(appData.short_description ?? ""));
  const about = stripHtml(String(appData.about_the_game ?? ""));

  return {
    id: steamAppId,
    title: String(appData.name ?? `Steam App ${steamAppId}`),
    developer: developers?.[0],
    publisher: publishers?.[0],
    tags,
    genre: genres.length ? genres : undefined,
    icon: headerImage ? { url: headerImage, medium_url: headerImage } : undefined,
    description: shortDesc ? { text: shortDesc } : undefined,
    developer_note: about ? { text: about.slice(0, 12_000) } : undefined,
    rec_text: genres.length ? genres.join(", ") : undefined,
    steam_appid: steamAppId,
  };
}

/**
 * Steam chỉ recommend / not recommend — map sang thang 5★ để đồng bộ stratification với TapTap:
 * recommend → 5★ (Very Positive); không → 2★ (Negative).
 */
function steamReviewToExternal(review: Record<string, unknown>): ExternalReview | null {
  const text = String(review.review ?? "").trim();
  if (text.length < 5) return null;

  const votedUp = review.voted_up === true;
  const score = votedUp ? 5 : 2;
  const bucket = RATING_BUCKETS.find((b) => score >= b.min && score <= b.max);
  if (!bucket) return null;

  const ts = Number(review.timestamp_created ?? 0);
  const date =
    ts > 0 ? new Date(ts * 1000).toISOString().slice(0, 10) : "unknown";

  return { text, score, date, bucket: bucket.label };
}

interface SteamReviewsApiResponse {
  response?: {
    reviews?: Record<string, unknown>[];
    cursor?: string;
  };
}

/** Cursor pagination; dừng tại maxReviews hoặc hết trang. */
export async function fetchSteamReviewsUpTo(appId: number, maxReviews: number = MAX_REVIEWS_CAP): Promise<ExternalReview[]> {
  const cap = Math.min(maxReviews, MAX_REVIEWS_CAP);
  const out: ExternalReview[] = [];
  const seenIds = new Set<string>();
  let cursor = "*";
  let pages = 0;

  while (out.length < cap) {
    // Enum: filter 1 = Recent, review_type 0 = All, purchase_type 1 = All (0 chỉ tính mua trên Steam).
    const input = {
      appid: appId,
      filter: 1,
      languages: ["all"],
      review_type: 0,
      purchase_type: 1,
      num_per_page: NUM_PER_PAGE,
      filter_offtopic_activity: false,
      cursor,
    };
    const url = `${STEAM_REVIEWS_API}?input_json=${encodeURIComponent(JSON.stringify(input))}`;
    const data = (await fetchJsonWithRetry(url)) as SteamReviewsApiResponse;
    const page = data.response;
    if (!page) throw new Error("Steam GetAppReviews trả về dữ liệu không hợp lệ");

    const batch = page.reviews ?? [];
    if (batch.length === 0) break;

    for (const rev of batch) {
      const rid = String(rev.recommendationid ?? "");
      if (rid && seenIds.has(rid)) continue;
      if (rid) seenIds.add(rid);

      const ext = steamReviewToExternal(rev);
      if (ext) out.push(ext);
      if (out.length >= cap) break;
    }

    const next = page.cursor;
    if (!next || next === cursor) break;
    cursor = next;
    pages++;

    if (out.length >= cap) break;
    if (PAGE_DELAY_MS > 0) await sleep(PAGE_DELAY_MS);
  }

  console.log(`[steam-client] appId=${appId}: collected ${out.length} reviews (cap=${cap}, pages=${pages})`);
  return out;
}
