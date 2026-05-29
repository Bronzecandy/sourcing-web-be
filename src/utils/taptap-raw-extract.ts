/** TapTap AppRank.raw field extractors (downloads, release date). */

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function statObj(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const app = o.app && typeof o.app === "object" ? (o.app as Record<string, unknown>) : o;
  const stat = app.stat;
  return stat && typeof stat === "object" ? (stat as Record<string, unknown>) : null;
}

/** TapTap download/install count from raw (hits_total preferred). */
export function downloadCountFromRaw(raw: unknown): number | null {
  const stat = statObj(raw);
  if (!stat) return null;
  for (const key of ["hits_total", "download_count", "pc_download_count", "play_total"] as const) {
    const n = num(stat[key]);
    if (n != null && n > 0) return Math.round(n);
  }
  return null;
}

/** Release / publish timestamp from TapTap raw (seconds or ms). */
export function releaseDateFromRaw(raw: unknown): Date | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const app =
    o.app && typeof o.app === "object" ? (o.app as Record<string, unknown>) : o;
  const keys = [
    "release_date",
    "released_time",
    "release_time",
    "publish_time",
    "published_time",
    "online_time",
  ];
  for (const k of keys) {
    const v = app[k];
    if (typeof v === "number" && Number.isFinite(v)) {
      const ms = v < 1e12 ? v * 1000 : v;
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) return d;
    }
    if (typeof v === "string" && v.trim()) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return null;
}

export function releaseDateIsoFromRaw(raw: unknown): string | null {
  const d = releaseDateFromRaw(raw);
  return d ? d.toISOString().split("T")[0]! : null;
}
