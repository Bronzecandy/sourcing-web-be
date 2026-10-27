import { extractDeveloperPublisher, extractInstallSizeMb, extractTags } from "./analysis-context";
import { fetchAppDetailRaw } from "./taptap-client.service";
import { fetchTapTapDetailRawViaProxy, fetchTapTapOfficialPosts } from "../utils/taptap-proxy-fetch";
import { releaseDateIsoFromRaw } from "../utils/taptap-raw-extract";
import type { RadarGameFacts } from "./radar-types";

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(/,/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function infoRows(raw: Record<string, unknown>): Array<{ title: string; text: string }> {
  const rows: Array<{ title: string; text: string }> = [];
  for (const key of ["information", "information_bar"] as const) {
    const list = raw[key];
    if (!Array.isArray(list)) continue;
    for (const row of list) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const title = typeof r.title === "string" ? r.title.trim() : "";
      const text =
        (typeof r.text === "string" && r.text.trim()) ||
        (typeof r.value === "string" && r.value.trim()) ||
        "";
      if (title || text) rows.push({ title, text });
    }
  }
  return rows;
}

function informationLines(raw: Record<string, unknown>): string[] {
  return infoRows(raw)
    .map(({ title, text }) => (title && text ? `${title}: ${text}` : title || text))
    .slice(0, 16);
}

function infoValue(raw: Record<string, unknown>, pattern: RegExp): string | null {
  const hit = infoRows(raw).find((r) => pattern.test(r.title) && r.text);
  return hit ? hit.text : null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>(?:\s*<br\s*\/?>)*/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#34;|&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function firstVideoUrl(raw: Record<string, unknown>): string | null {
  for (const key of ["videos", "app_videos"] as const) {
    const list = raw[key];
    if (!Array.isArray(list)) continue;
    for (const v of list) {
      if (!v || typeof v !== "object") continue;
      const rec = v as Record<string, unknown>;
      const id = num(rec.video_id) ?? num(rec.id);
      if (id) return `https://www.taptap.cn/video/${id}`;
    }
  }
  return null;
}

async function loadDetail(appId: number): Promise<Record<string, unknown> | null> {
  try {
    const viaProxy = await fetchTapTapDetailRawViaProxy(appId);
    if (viaProxy) return viaProxy;
  } catch {
    // fall back to direct
  }
  try {
    return await fetchAppDetailRaw(appId);
  } catch {
    return null;
  }
}

export async function researchRadarGame(
  appId: number,
  title: string,
  opts: { withPosts?: boolean } = {},
): Promise<RadarGameFacts> {
  const raw = await loadDetail(appId);
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
      fetched: false,
    };
  }

  const officialPosts = opts.withPosts === false ? [] : await fetchTapTapOfficialPosts(appId, 8);
  const stat = (raw.stat && typeof raw.stat === "object" ? raw.stat : {}) as Record<string, unknown>;
  const ratingObj = stat.rating as Record<string, unknown> | undefined;
  const parties = extractDeveloperPublisher(raw);
  const hints = Array.isArray(raw.hints) ? raw.hints.filter((h): h is string => typeof h === "string") : [];
  const note = raw.developer_note as { text?: unknown } | undefined;
  const online = infoValue(raw, /联网/);
  const launchInfo = infoValue(raw, /正式上线日期|上线日期|发售日期/);

  return {
    appId,
    title: (typeof raw.title === "string" && raw.title.trim()) || title,
    tags: extractTags(raw).slice(0, 12),
    developer: parties.developerName,
    publisher: parties.publisherName ?? infoValue(raw, /^厂商$/),
    rating: typeof ratingObj?.score === "string" ? ratingObj.score : null,
    reserveCount: num(stat.reserve_count),
    downloadCount: num(stat.hits_total) ?? num(stat.download_count) ?? num(stat.play_total),
    fansCount: num(stat.fans_count),
    installSizeMb: extractInstallSizeMb(raw),
    notes: informationLines(raw),
    flag: num(raw.flag),
    hints,
    developerNote: typeof note?.text === "string" ? stripHtml(note.text).slice(0, 700) : null,
    officialPosts,
    releaseDate:
      (launchInfo && /^\d{4}-\d{2}-\d{2}/.test(launchInfo) ? launchInfo.slice(0, 10) : null) ??
      releaseDateIsoFromRaw(raw),
    updateDate: infoValue(raw, /更新时间/),
    online: online == null ? null : /是/.test(online) ? true : /否/.test(online) ? false : null,
    videoUrl: firstVideoUrl(raw),
    fetched: true,
  };
}
