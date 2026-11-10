import { marketQuery, num, sqlIntList, sqlLike, sqlList, sqlText, str, strArray } from "../../utils/market-data";
import type { SteamRef, SteamReport } from "./types";

export interface SteamInfo extends SteamRef {
  tags: string[];
  isFree: boolean | null;
  priceUsd: number | null;
}

function releaseDate(text: unknown): string | null {
  const s = str(text);
  if (!s) return null;
  const d = new Date(`${s} UTC`);
  return Number.isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10);
}

function tagList(official: unknown, steamspy: unknown): string[] {
  const parse = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.map((t) => (typeof t === "string" ? t : (t as { name?: string })?.name ?? "")).filter(Boolean);
    if (v && typeof v === "object") return Object.keys(v as object);
    if (typeof v === "string") {
      try {
        return parse(JSON.parse(v));
      } catch {
        return strArray(v);
      }
    }
    return [];
  };
  const tags = parse(official);
  return (tags.length ? tags : parse(steamspy)).slice(0, 15);
}

function bool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "t") return true;
  if (v === "false" || v === "f") return false;
  return null;
}

export async function steamInfos(steamAppIds: number[]): Promise<Map<number, SteamInfo>> {
  const out = new Map<number, SteamInfo>();
  const list = [...new Set(steamAppIds.filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, 100);
  if (!list.length) return out;
  const rows = await marketQuery(
    "steam",
    `SELECT steam_app_id, game_name, app_name, developers, publishers, release_date_text, header_image, is_free,
            game_price_usd, tags_steam_official, tags_steamspy
       FROM steam.dim_game_info WHERE steam_app_id IN (${sqlIntList(list)})`,
  );
  for (const r of rows) {
    const id = num(r.steam_app_id);
    if (!id) continue;
    out.set(id, {
      steamAppId: id,
      name: str(r.game_name) ?? str(r.app_name) ?? `Steam ${id}`,
      developers: strArray(r.developers),
      publishers: strArray(r.publishers),
      releaseDate: releaseDate(r.release_date_text),
      headerImage: str(r.header_image),
      tags: tagList(r.tags_steam_official, r.tags_steamspy),
      isFree: bool(r.is_free),
      priceUsd: num(r.game_price_usd),
    });
  }
  return out;
}

export function steamRefOf(info: SteamInfo): SteamRef {
  return {
    steamAppId: info.steamAppId,
    name: info.name,
    developers: info.developers,
    publishers: info.publishers,
    releaseDate: info.releaseDate,
    headerImage: info.headerImage,
  };
}

/** Steam names are English-only; search with international names. */
export async function steamNameSearch(names: string[]): Promise<number[]> {
  const list = [...new Set(names.map((n) => n.trim()).filter((n) => n.length >= 3))].slice(0, 6);
  if (!list.length) return [];
  const rows = await marketQuery(
    "steam",
    `SELECT steam_app_id FROM steam.dim_game_info WHERE ${list.map((n) => `game_name ILIKE ${sqlLike(n)}`).join(" OR ")} LIMIT 30`,
  );
  return rows.map((r) => num(r.steam_app_id)).filter((v): v is number => v !== null);
}

/** lower(name) → steam ids with exactly that name. */
export async function steamByExactNames(names: string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  const list = [...new Set(names.map((n) => n.trim().toLowerCase()).filter((n) => n.length >= 4))].slice(0, 300);
  if (!list.length) return out;
  const rows = await marketQuery("steam", `SELECT steam_app_id, lower(game_name) AS n FROM steam.dim_game_info WHERE lower(game_name) IN (${sqlList(list)})`);
  for (const r of rows) {
    const n = str(r.n);
    const id = num(r.steam_app_id);
    if (!n || !id) continue;
    out.set(n, [...(out.get(n) ?? []), id]);
  }
  return out;
}

export async function steamLatestReviews(steamAppIds: number[]): Promise<Map<number, { total: number | null; positive: number | null }>> {
  const out = new Map<number, { total: number | null; positive: number | null }>();
  if (!steamAppIds.length) return out;
  const rows = await marketQuery(
    "steam",
    `SELECT DISTINCT ON (steam_app_id) steam_app_id, reviews_count, positive_reviews_count
       FROM steam.fact_game_review_rating_snapshots
      WHERE steam_app_id IN (${sqlIntList(steamAppIds)}) AND review_language = 'all' AND observed_at >= now() - interval '21 days'
      ORDER BY steam_app_id, observed_at DESC`,
  );
  for (const r of rows) {
    const id = num(r.steam_app_id);
    if (id) out.set(id, { total: num(r.reviews_count), positive: num(r.positive_reviews_count) });
  }
  return out;
}

const iso = (v: unknown) => str(v) ?? "";

function closestTo<T extends { at: string }>(rows: T[], target: number): T | null {
  let best: T | null = null;
  let gap = Infinity;
  for (const r of rows) {
    const d = Math.abs(new Date(r.at).getTime() - target);
    if (d < gap) {
      gap = d;
      best = r;
    }
  }
  return best;
}

export type SteamRaw = Omit<SteamReport, "metrics" | "steamScore" | "notes">;

export async function steamRaw(info: SteamInfo, fromDate: string): Promise<SteamRaw> {
  const id = info.steamAppId;
  const [ccu, reviews, popularity, sales, activeness, ranks] = await Promise.all([
    marketQuery(
      "steam",
      `SELECT record_date, source_name, avg_ccu, max_ccu FROM steam.v_game_ccu_daily_complete
        WHERE steam_app_id = ${id} AND record_date >= DATE ${sqlText(fromDate)} ORDER BY record_date`,
    ),
    marketQuery(
      "steam",
      `SELECT observed_at, reviews_count, positive_reviews_count, rating_label FROM steam.fact_game_review_rating_snapshots
        WHERE steam_app_id = ${id} AND review_language = 'all' AND observed_at >= now() - interval '45 days'
        ORDER BY observed_at DESC LIMIT 60`,
    ),
    marketQuery(
      "steam",
      `SELECT observed_at, source_name, followers_count, wishlist_count FROM steam.fact_game_popularity_snapshots
        WHERE steam_app_id = ${id} AND source_name = 'vgi' AND observed_at >= now() - interval '60 days'
        ORDER BY observed_at DESC LIMIT 20`,
    ),
    marketQuery(
      "steam",
      `SELECT observed_at, units_sold_estimate, revenue_estimate FROM steam.fact_game_sales_revenue_snapshots
        WHERE steam_app_id = ${id} ORDER BY observed_at DESC LIMIT 1`,
    ),
    marketQuery(
      "steam",
      `SELECT observed_at, source_name, players_total_estimate, active_players_estimate, average_playtime_hours
         FROM steam.fact_game_player_activeness_snapshots WHERE steam_app_id = ${id} ORDER BY observed_at DESC LIMIT 6`,
    ),
    marketQuery(
      "steam",
      `SELECT rank_name, rank_scope, rank_value, rank_date FROM steam.fact_game_rank_snapshots
        WHERE steam_app_id = ${id} AND rank_date >= DATE ${sqlText(fromDate)} ORDER BY rank_date DESC LIMIT 300`,
    ),
  ]);

  const byDate = new Map<string, { avg: number | null; max: number | null; primary: boolean }>();
  for (const r of ccu) {
    const date = iso(r.record_date).slice(0, 10);
    const primary = str(r.source_name) === "steam_api";
    const prev = byDate.get(date);
    if (prev && prev.primary && !primary) continue;
    byDate.set(date, { avg: num(r.avg_ccu), max: num(r.max_ccu), primary });
  }
  const ccuDaily = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, avg: v.avg, max: v.max }));

  const reviewRows = reviews.map((r) => ({ at: iso(r.observed_at), total: num(r.reviews_count), positive: num(r.positive_reviews_count), label: str(r.rating_label) }));
  const latestReview = reviewRows[0] ?? null;
  const monthAgo = latestReview ? closestTo(reviewRows, new Date(latestReview.at).getTime() - 30 * 86_400_000) : null;

  const popRows = popularity.map((r) => ({ at: iso(r.observed_at), followers: num(r.followers_count), wishlist: num(r.wishlist_count) }));
  const latestPop = popRows.find((r) => r.followers !== null || r.wishlist !== null) ?? null;
  const pop4w = latestPop ? closestTo(popRows.filter((r) => r !== latestPop), new Date(latestPop.at).getTime() - 28 * 86_400_000) : null;

  const act = activeness.map((r) => ({
    at: iso(r.observed_at),
    total: num(r.players_total_estimate),
    active: num(r.active_players_estimate),
    playtime: num(r.average_playtime_hours),
  }));
  const pick = <K extends "total" | "active" | "playtime">(k: K) => act.find((r) => r[k] !== null)?.[k] ?? null;

  const latestRank = new Map<string, { name: string; scope: string; value: number; date: string }>();
  for (const r of ranks) {
    const name = str(r.rank_name);
    const scope = str(r.rank_scope) ?? "";
    const value = num(r.rank_value);
    if (!name || value === null) continue;
    const key = `${name}\n${scope}`;
    if (!latestRank.has(key)) latestRank.set(key, { name, scope, value, date: iso(r.rank_date).slice(0, 10) });
  }

  return {
    ref: steamRefOf(info),
    tags: info.tags,
    isFree: info.isFree,
    priceUsd: info.priceUsd,
    ccuDaily,
    reviews: latestReview
      ? {
          total: latestReview.total,
          positive: latestReview.positive,
          positivePct: latestReview.total && latestReview.positive !== null ? (latestReview.positive / latestReview.total) * 100 : null,
          label: latestReview.label,
          total30dAgo: monthAgo && monthAgo !== latestReview ? monthAgo.total : null,
          observedAt: latestReview.at,
        }
      : null,
    popularity: latestPop
      ? { followers: latestPop.followers, wishlist: latestPop.wishlist, followers4wAgo: pop4w?.followers ?? null, wishlist4wAgo: pop4w?.wishlist ?? null, observedAt: latestPop.at }
      : null,
    sales: sales[0] ? { unitsSold: num(sales[0].units_sold_estimate), revenueUsd: num(sales[0].revenue_estimate), observedAt: iso(sales[0].observed_at) } : null,
    activeness: act.length ? { playersTotal: pick("total"), activePlayers: pick("active"), avgPlaytimeHours: pick("playtime"), observedAt: act[0].at } : null,
    ranks: [...latestRank.values()].slice(0, 12),
  };
}
