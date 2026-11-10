import { pool } from "../../utils/prisma";
import { withDbRetry } from "../../utils/db-retry";

export interface TapTapFacts {
  appId: number;
  title: string;
  iconUrl: string | null;
  developers: Array<{ name: string; type: string | null }>;
  itunesId: string | null;
  androidPackage: string | null;
  releaseDate: string | null;
  tags: string[];
  rating: string | null;
  fans: number | null;
  reserveCount: number | null;
  downloadCount: number | null;
  lastSeen: string;
}

type Row = {
  appId: number;
  date: Date;
  title: string | null;
  itunes: string | null;
  identifier: string | null;
  developers: unknown;
  released: string | null;
  icon: string | null;
  tags: unknown;
  stat: unknown;
};

function epochDate(value: string | null): string | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString().slice(0, 10);
}

function developers(value: unknown): TapTapFacts["developers"] {
  if (!Array.isArray(value)) return [];
  return value
    .map((d) => (d && typeof d === "object" ? (d as { name?: unknown; type?: unknown }) : null))
    .filter((d): d is { name?: unknown; type?: unknown } => d !== null && typeof d.name === "string" && d.name.trim() !== "")
    .map((d) => ({ name: String(d.name).trim(), type: typeof d.type === "string" ? d.type : null }));
}

function tags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((t) => (typeof t === "string" ? t : t && typeof t === "object" ? (t as { value?: unknown }).value : null))
    .filter((t): t is string => typeof t === "string" && t.trim() !== "")
    .slice(0, 12);
}

function statNumber(stat: unknown, ...keys: string[]): number | null {
  if (!stat || typeof stat !== "object") return null;
  for (const key of keys) {
    const v = (stat as Record<string, unknown>)[key];
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function rating(stat: unknown): string | null {
  if (!stat || typeof stat !== "object") return null;
  const r = (stat as { rating?: { score?: unknown } }).rating;
  return r && (typeof r.score === "string" || typeof r.score === "number") ? String(r.score) : null;
}

function cleanId(value: string | null, pattern: RegExp): string | null {
  const v = value?.trim();
  return v && v !== "null" && pattern.test(v) ? v : null;
}

/** Latest TapTap snapshot per app from the crawl DB (last 45 days of AppRank). */
export async function loadTapTapFacts(appIds: number[]): Promise<Map<number, TapTapFacts>> {
  const ids = [...new Set(appIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  const out = new Map<number, TapTapFacts>();
  if (!ids.length) return out;
  const { rows } = await withDbRetry(
    () =>
      pool.query<Row>(
        `SELECT DISTINCT ON ("appId") "appId", date,
                raw->>'title' AS title, raw->>'itunes_id' AS itunes, raw->>'identifier' AS identifier,
                raw->'developers' AS developers, raw->>'released_time' AS released,
                raw->'icon'->>'url' AS icon, raw->'tags' AS tags, raw->'stat' AS stat
           FROM "AppRank"
          WHERE "appId" = ANY($1::int[]) AND date >= CURRENT_DATE - 45
          ORDER BY "appId", date DESC`,
        [ids],
      ),
    "deep-research-taptap",
  );
  for (const r of rows) {
    out.set(r.appId, {
      appId: r.appId,
      title: r.title?.trim() || `App #${r.appId}`,
      iconUrl: r.icon ?? null,
      developers: developers(r.developers),
      itunesId: cleanId(r.itunes, /^\d{6,12}$/),
      androidPackage: cleanId(r.identifier, /^[A-Za-z][\w]*(\.[\w]+)+$/),
      releaseDate: epochDate(r.released),
      tags: tags(r.tags),
      rating: rating(r.stat),
      fans: statNumber(r.stat, "fans_count"),
      reserveCount: statNumber(r.stat, "reserve_count"),
      downloadCount: statNumber(r.stat, "hits_total", "download_count", "play_total"),
      lastSeen: r.date.toISOString().slice(0, 10),
    });
  }
  return out;
}

export async function loadTapTapFact(appId: number): Promise<TapTapFacts | null> {
  return (await loadTapTapFacts([appId])).get(appId) ?? null;
}
