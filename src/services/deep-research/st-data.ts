import { isUnifiedId, marketQuery, num, sqlLike, sqlList, sqlText, str } from "../../utils/market-data";
import type { Country, MarketSeries, MonthSnapshot, StRef } from "./types";

export const COUNTRIES: Country[] = ["CN", "WW", "VN"];

function ictToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 10);
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Previous calendar month once the warehouse has had ~10 days to load it; otherwise the month before. */
export function lastFullMonth(today = ictToday()): string {
  const [y, m, d] = today.split("-").map(Number);
  const current = `${y}-${String(m).padStart(2, "0")}-01`;
  return addMonths(current, d >= 10 ? -1 : -2);
}

export function daysAgo(n: number, today = ictToday()): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function isoDay(value: unknown): string | null {
  const s = str(value);
  return s ? s.slice(0, 10) : null;
}

/** Sensor Tower revenue is stored in cents. */
export function usd(value: unknown): number | null {
  const n = num(value);
  return n === null ? null : n / 100;
}

/** DAU/MAU of 0 means Sensor Tower has no estimate for that market, not zero players. */
function users(value: unknown): number | null {
  const n = num(value);
  return n !== null && n > 0 ? n : null;
}

const ids = (values: Iterable<string>) => sqlList([...values].filter(isUnifiedId));

/** app_id (iTunes numeric id or Android package) → unified_app_id. */
export async function stByStoreIds(itunes: string[], packages: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const parts: string[] = [];
  if (itunes.length) parts.push(`(os = 'ios' AND app_id IN (${sqlList(itunes)}))`);
  if (packages.length) parts.push(`(os = 'android' AND app_id IN (${sqlList(packages)}))`);
  if (!parts.length) return out;
  const rows = await marketQuery(
    "sensortower",
    `SELECT app_id, unified_app_id FROM core.dim_app_info WHERE unified_app_id IS NOT NULL AND (${parts.join(" OR ")})`,
  );
  for (const r of rows) {
    const appId = str(r.app_id);
    const uid = str(r.unified_app_id);
    if (appId && isUnifiedId(uid)) out.set(appId, uid);
  }
  return out;
}

/** Exact app or game name → unified ids carrying it. */
export async function stByExactNames(names: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const list = [...new Set(names.filter(Boolean))].slice(0, 400);
  if (!list.length) return out;
  const add = (name: unknown, uid: unknown) => {
    const n = str(name);
    if (!n || !isUnifiedId(uid)) return;
    if (!out.has(n)) out.set(n, new Set());
    out.get(n)!.add(uid);
  };
  const [apps, games] = await Promise.all([
    marketQuery("sensortower", `SELECT name, unified_app_id FROM core.dim_app_info WHERE unified_app_id IS NOT NULL AND name IN (${sqlList(list)})`),
    marketQuery("sensortower", `SELECT name, unified_app_id FROM core.dim_game_info WHERE name IN (${sqlList(list)})`),
  ]);
  for (const r of apps) add(r.name, r.unified_app_id);
  for (const r of games) add(r.name, r.unified_app_id);
  return out;
}

export interface StGameInfo extends StRef {
  taxonomy: Record<string, string | null>;
  releaseDates: { earliest: string | null; ww: string | null; cn: string | null };
}

export async function stGameInfos(unifiedIds: string[]): Promise<Map<string, StGameInfo>> {
  const out = new Map<string, StGameInfo>();
  const list = [...new Set(unifiedIds.filter(isUnifiedId))].slice(0, 200);
  if (!list.length) return out;
  const games = await marketQuery(
    "sensortower",
    `SELECT unified_app_id, canonical_app_id, name, game_class, game_genre, game_subgenre, game_art_style, game_camera_pov,
            game_setting, game_theme, game_product_model, game_licensed_ip, game_ip_corporate_parent,
            game_earliest_release_date, game_release_date_ww, game_release_date_cn
       FROM core.dim_game_info WHERE unified_app_id IN (${ids(list)})`,
  );
  const canon = games.map((g) => str(g.canonical_app_id)).filter((v): v is string => Boolean(v));
  const apps = canon.length
    ? await marketQuery("sensortower", `SELECT app_id, icon_url, publisher_name, cleaned_publisher_name FROM core.dim_app_info WHERE app_id IN (${sqlList(canon)})`)
    : [];
  const appById = new Map(apps.map((a) => [str(a.app_id), a]));
  for (const g of games) {
    const uid = str(g.unified_app_id);
    if (!isUnifiedId(uid)) continue;
    const app = appById.get(str(g.canonical_app_id));
    out.set(uid, {
      unifiedId: uid,
      name: str(g.name) ?? uid,
      publisher: str(app?.cleaned_publisher_name) ?? str(app?.publisher_name),
      iconUrl: str(app?.icon_url),
      gameClass: str(g.game_class),
      genre: str(g.game_genre),
      subgenre: str(g.game_subgenre),
      releaseDate: isoDay(g.game_earliest_release_date),
      taxonomy: {
        class: str(g.game_class),
        genre: str(g.game_genre),
        subgenre: str(g.game_subgenre),
        artStyle: str(g.game_art_style),
        cameraPov: str(g.game_camera_pov),
        setting: str(g.game_setting),
        theme: str(g.game_theme),
        productModel: str(g.game_product_model),
        licensedIp: str(g.game_licensed_ip),
        ipOwner: str(g.game_ip_corporate_parent),
      },
      releaseDates: { earliest: isoDay(g.game_earliest_release_date), ww: isoDay(g.game_release_date_ww), cn: isoDay(g.game_release_date_cn) },
    });
  }
  return out;
}

/** Fuzzy name search over app names (incl. Chinese store names) and unified game names. */
export async function stNameSearch(names: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const list = [...new Set(names.map((n) => n.trim()).filter((n) => n.length >= 2))].slice(0, 6);
  if (!list.length) return out;
  const add = (uid: unknown, name: unknown) => {
    const n = str(name);
    if (!isUnifiedId(uid) || !n) return;
    if (!out.has(uid)) out.set(uid, new Set());
    out.get(uid)!.add(n);
  };
  const appCond = list.map((n) => `name ILIKE ${sqlLike(n)} OR humanized_name ILIKE ${sqlLike(n)}`).join(" OR ");
  const gameCond = list.map((n) => `name ILIKE ${sqlLike(n)}`).join(" OR ");
  const [apps, games] = await Promise.all([
    marketQuery("sensortower", `SELECT unified_app_id, name, humanized_name FROM core.dim_app_info WHERE unified_app_id IS NOT NULL AND (${appCond}) LIMIT 80`),
    marketQuery("sensortower", `SELECT unified_app_id, name FROM core.dim_game_info WHERE ${gameCond} LIMIT 40`),
  ]);
  for (const r of apps) {
    add(r.unified_app_id, r.name);
    add(r.unified_app_id, r.humanized_name);
  }
  for (const r of games) add(r.unified_app_id, r.name);
  return out;
}

/** Monthly CN/WW rows for the given months. */
export async function stMonthSnapshots(unifiedIds: string[], months: string[]): Promise<Map<string, MonthSnapshot[]>> {
  const out = new Map<string, MonthSnapshot[]>();
  const list = [...new Set(unifiedIds.filter(isUnifiedId))];
  if (!list.length || !months.length) return out;
  for (let i = 0; i < list.length; i += 120) {
    const chunk = list.slice(i, i + 120);
    const rows = await marketQuery(
      "sensortower",
      `SELECT unified_app_id, country, month, downloads, revenue, avg_dau, mau
         FROM analytics.agg_game_performance_monthly
        WHERE unified_app_id IN (${ids(chunk)}) AND country IN ('CN', 'WW')
          AND month IN (${months.map((m) => `DATE ${sqlText(m)}`).join(", ")})`,
    );
    for (const r of rows) {
      const uid = str(r.unified_app_id);
      if (!isUnifiedId(uid)) continue;
      if (!out.has(uid)) out.set(uid, []);
      out.get(uid)!.push({
        country: str(r.country) as Country,
        month: isoDay(r.month) ?? "",
        revenueUsd: usd(r.revenue),
        avgDau: users(r.avg_dau),
        downloads: num(r.downloads),
        mau: users(r.mau),
      });
    }
  }
  return out;
}

export async function stMonthlySeries(unifiedId: string, fromMonth: string, toMonth: string): Promise<Partial<Record<Country, MarketSeries["monthly"]>>> {
  if (!isUnifiedId(unifiedId)) return {};
  const rows = await marketQuery(
    "sensortower",
    `SELECT country, month, downloads, revenue, avg_dau, mau FROM analytics.agg_game_performance_monthly
      WHERE unified_app_id = ${sqlText(unifiedId)} AND month >= DATE ${sqlText(fromMonth)} AND month <= DATE ${sqlText(toMonth)}
      ORDER BY country, month`,
  );
  const out: Partial<Record<Country, MarketSeries["monthly"]>> = {};
  for (const r of rows) {
    const c = str(r.country) as Country;
    if (!COUNTRIES.includes(c)) continue;
    (out[c] ??= []).push({ month: isoDay(r.month) ?? "", revenueUsd: usd(r.revenue), avgDau: users(r.avg_dau), downloads: num(r.downloads), mau: users(r.mau) });
  }
  return out;
}

export async function stDailySeries(unifiedId: string, fromDate: string): Promise<Partial<Record<Country, MarketSeries["daily"]>>> {
  if (!isUnifiedId(unifiedId)) return {};
  const rows = await marketQuery(
    "sensortower",
    `SELECT country, date, downloads, revenue, dau FROM analytics.agg_game_performance_daily
      WHERE unified_app_id = ${sqlText(unifiedId)} AND date >= DATE ${sqlText(fromDate)} AND country IN ('CN', 'WW')
      ORDER BY country, date`,
  );
  const out: Partial<Record<Country, MarketSeries["daily"]>> = {};
  for (const r of rows) {
    const c = str(r.country) as Country;
    (out[c] ??= []).push({ date: isoDay(r.date) ?? "", revenueUsd: usd(r.revenue), dau: users(r.dau), downloads: num(r.downloads) });
  }
  return out;
}

export interface CohortRow {
  unifiedId: string;
  name: string;
  revenueUsd: number | null;
  avgDau: number | null;
  downloads: number | null;
  mau: number | null;
}

export async function stCohort(country: Country, month: string, level: "subgenre" | "genre", value: string): Promise<CohortRow[]> {
  const column = level === "subgenre" ? "game_subgenre" : "game_genre";
  const rows = await marketQuery(
    "sensortower",
    `SELECT unified_app_id, game_name, downloads, revenue, avg_dau, mau FROM analytics.agg_game_performance_monthly
      WHERE country = ${sqlText(country)} AND month = DATE ${sqlText(month)} AND ${column} = ${sqlText(value)}
        AND (revenue > 0 OR avg_dau > 0 OR downloads > 0)
      ORDER BY revenue DESC NULLS LAST LIMIT 500`,
  );
  return rows
    .filter((r) => isUnifiedId(r.unified_app_id))
    .map((r) => ({
      unifiedId: String(r.unified_app_id),
      name: str(r.game_name) ?? String(r.unified_app_id),
      revenueUsd: usd(r.revenue),
      avgDau: users(r.avg_dau),
      downloads: num(r.downloads),
      mau: users(r.mau),
    }));
}

export async function stSubgenreTrend(country: Country, subgenre: string, fromMonth: string, toMonth: string) {
  const rows = await marketQuery(
    "sensortower",
    `SELECT month, downloads, revenue, avg_dau FROM analytics.agg_subgenre_performance_monthly
      WHERE country = ${sqlText(country)} AND subgenre = ${sqlText(subgenre)}
        AND month >= DATE ${sqlText(fromMonth)} AND month <= DATE ${sqlText(toMonth)}
      ORDER BY month`,
  );
  return rows.map((r) => ({ month: isoDay(r.month) ?? "", revenueUsd: usd(r.revenue), avgDau: users(r.avg_dau), downloads: num(r.downloads) }));
}
