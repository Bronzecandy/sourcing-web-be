import { extractDeveloperPublisher, extractInstallSizeMb, extractTags } from "./analysis-context";
import { fetchAppDetailRaw } from "./taptap-client.service";
import { fetchTapTapDetailRawViaProxy } from "../utils/taptap-proxy-fetch";
import type { RadarGameFacts } from "./radar-types";

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(/,/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function informationLines(raw: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const key of ["information", "information_bar"] as const) {
    const rows = raw[key];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const title = typeof r.title === "string" ? r.title.trim() : "";
      const text =
        (typeof r.text === "string" && r.text.trim()) ||
        (typeof r.value === "string" && r.value.trim()) ||
        "";
      if (!title && !text) continue;
      lines.push(title && text ? `${title}: ${text}` : title || text);
    }
  }
  return lines.slice(0, 16);
}

export async function researchRadarGame(appId: number, title: string): Promise<RadarGameFacts> {
  let raw: Record<string, unknown> | null = null;
  try {
    raw = await fetchTapTapDetailRawViaProxy(appId);
  } catch {
    raw = null;
  }
  if (!raw) {
    try {
      raw = await fetchAppDetailRaw(appId);
    } catch {
      raw = null;
    }
  }

  if (!raw) {
    return {
      appId,
      title,
      tags: [],
      developer: null,
      publisher: null,
      rating: null,
      reserveCount: null,
      downloadCount: null,
      fansCount: null,
      installSizeMb: null,
      notes: ["Không tải được trang TapTap kỳ này."],
    };
  }

  const stat = (raw.stat && typeof raw.stat === "object" ? raw.stat : {}) as Record<string, unknown>;
  const ratingObj = stat.rating as Record<string, unknown> | undefined;
  const parties = extractDeveloperPublisher(raw);
  return {
    appId,
    title: (typeof raw.title === "string" && raw.title.trim()) || title,
    tags: extractTags(raw).slice(0, 12),
    developer: parties.developerName,
    publisher: parties.publisherName,
    rating: typeof ratingObj?.score === "string" ? ratingObj.score : null,
    reserveCount: num(stat.reserve_count),
    downloadCount: num(stat.hits_total) ?? num(stat.download_count) ?? num(stat.play_count),
    fansCount: num(stat.fans_count),
    installSizeMb: extractInstallSizeMb(raw),
    notes: informationLines(raw),
  };
}
