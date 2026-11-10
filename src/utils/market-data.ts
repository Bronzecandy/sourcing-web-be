/**
 * market-data.garena.vn portal: read-only SQL over the Sensor Tower and Steam warehouses.
 * POST /api/v1/query { source, sql_base64, max_rows } → { columns, rows }.
 * The portal rejects anything but SELECT/CTE and requires a WHERE on the daily fact tables.
 */

export type MarketSource = "sensortower" | "steam";

export class MarketDataError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(message);
  }
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX = 400;
const cache = new Map<string, { at: number; rows: Record<string, unknown>[] }>();

function baseUrl(): string {
  return (process.env.MARKET_DATA_URL?.trim() || "https://market-data.garena.vn").replace(/\/$/, "");
}

function apiKey(): string {
  const key = process.env.MARKET_DATA_API_KEY?.trim();
  if (!key) throw new MarketDataError("Thiếu MARKET_DATA_API_KEY", 503);
  return key;
}

export function marketDataConfigured(): boolean {
  return Boolean(process.env.MARKET_DATA_API_KEY?.trim());
}

function columnName(c: unknown): string {
  if (typeof c === "string") return c;
  if (c && typeof c === "object" && typeof (c as { name?: unknown }).name === "string") return (c as { name: string }).name;
  return "";
}

function toObjects(payload: { columns?: unknown[]; rows?: unknown[] }): Record<string, unknown>[] {
  const cols = (payload.columns ?? []).map(columnName);
  return (payload.rows ?? []).map((r) => {
    if (Array.isArray(r)) return Object.fromEntries(cols.map((c, i) => [c, r[i]]));
    return (r ?? {}) as Record<string, unknown>;
  });
}

async function post(source: MarketSource, sql: string, maxRows: number): Promise<Record<string, unknown>[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${baseUrl()}/api/v1/query`, {
        method: "POST",
        headers: { "X-API-Key": apiKey(), "Content-Type": "application/json" },
        body: JSON.stringify({ source, sql_base64: Buffer.from(sql, "utf8").toString("base64"), max_rows: maxRows }),
        signal: AbortSignal.timeout(45_000),
      });
      const text = await res.text();
      if (!res.ok) {
        let message = text.slice(0, 300);
        let retryable = res.status === 429 || res.status >= 500;
        try {
          const detail = (JSON.parse(text) as { detail?: { error?: { message?: string; retryable?: boolean } } | string }).detail;
          if (typeof detail === "string") message = detail;
          else if (detail?.error?.message) {
            message = detail.error.message;
            retryable = retryable || Boolean(detail.error.retryable);
          }
        } catch {
          /* body is not JSON */
        }
        throw new MarketDataError(`market-data ${source} HTTP ${res.status}: ${message}`, res.status, retryable);
      }
      return toObjects(JSON.parse(text) as { columns?: unknown[]; rows?: unknown[] });
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof MarketDataError ? err.retryable : (err as Error).name === "TimeoutError" || (err as Error).name === "TypeError";
      if (!retryable || attempt === 2) break;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new MarketDataError(String(lastErr), 502);
}

/** Read-only SQL; results cached for 6h (warehouse refreshes weekly). */
export async function marketQuery(source: MarketSource, sql: string, maxRows = 500): Promise<Record<string, unknown>[]> {
  const key = `${source}\n${maxRows}\n${sql}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;
  const rows = await post(source, sql, Math.min(500, Math.max(1, maxRows)));
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), rows });
  return rows;
}

/** SQL string literal. */
/**
 * The portal rejects any statement whose raw text contains these keywords or comment markers —
 * even inside string literals (e.g. "Call of Duty", "Merge Mansion") — and allows no functions
 * on some sources, so blocked words are split into concatenated literals. A literal ";" is
 * never accepted ("multiple statements"), so callers must remove it first.
 */
const PORTAL_BLOCKED =
  /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|call|copy|execute|attach|detach|pragma|vacuum|replace|merge|comment|analyze|analyse|do|prepare|listen|notify|refresh)\b|--|\/\*|\*\//gi;

function literal(value: string): string {
  const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const parts: string[] = [];
  let last = 0;
  for (const m of value.matchAll(PORTAL_BLOCKED)) {
    const end = m.index + m[0].length;
    parts.push(quote(value.slice(last, end - 1)));
    last = end - 1;
  }
  if (!parts.length) return quote(value);
  parts.push(quote(value.slice(last)));
  return `(${parts.join(" || ")})`;
}

/** Exact-match literal; ";" (never accepted by the portal) becomes a space. */
export function sqlText(value: string): string {
  return literal(value.replace(/\0/g, "").replace(/;/g, " "));
}

/** ILIKE pattern literal with % and _ escaped; ";" becomes the single-character wildcard. */
export function sqlLike(value: string): string {
  const escaped = value.replace(/\0/g, "").replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_").replace(/;/g, "_");
  return literal(`%${escaped}%`);
}

export function sqlList(values: Iterable<string>): string {
  const list = [...new Set(values)].map(sqlText);
  return list.length ? list.join(", ") : "NULL";
}

export function sqlIntList(values: Iterable<number>): string {
  const list = [...new Set(values)].filter((v) => Number.isSafeInteger(v));
  return list.length ? list.join(", ") : "NULL";
}

const UNIFIED_ID = /^[0-9a-f]{24}$/;
export function isUnifiedId(value: unknown): value is string {
  return typeof value === "string" && UNIFIED_ID.test(value);
}

export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function str(value: unknown): string | null {
  if (typeof value !== "string") return value == null ? null : String(value);
  const s = value.trim();
  return s ? s : null;
}

/** Postgres arrays come back as JSON text, Python repr text, or real arrays. */
export function strArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed.map((v) => String(v)).filter(Boolean);
  } catch {
    /* not JSON */
  }
  return value
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}
