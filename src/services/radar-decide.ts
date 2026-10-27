import fs from "fs";
import path from "path";
import { jsonrepair } from "jsonrepair";
import { callLLM } from "../utils/ai-client";
import { formatViDate, scheduleLabel } from "./radar-schedule";
import type { RadarFlags, RadarGameFacts, RadarSchedule, ScheduleKind } from "./radar-types";

let promptCache: string | null = null;

function systemPrompt(): string {
  if (promptCache) return promptCache;
  const file = path.join(process.cwd(), "data", "radar", "next-action-prompt.md");
  promptCache = fs.readFileSync(file, "utf8");
  return promptCache;
}

function parseJsonObject(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced?.[1] ?? text).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  const slice = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
  try {
    return JSON.parse(slice) as Record<string, unknown>;
  } catch {
    return JSON.parse(jsonrepair(slice)) as Record<string, unknown>;
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function bool(v: unknown, fallback = false): boolean {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return fallback;
}

const SCHEDULE_KINDS = new Set<ScheduleKind>([
  "launched",
  "open_beta",
  "launch_date",
  "closed_beta",
  "test_recruit",
  "test_running",
]);

export interface RadarExtraction {
  titleEn: string;
  genre: string;
  publisher: string;
  insights: string;
  flags: RadarFlags;
  schedule: { kind: ScheduleKind; date: string | null; note: string } | null;
}

export async function extractRadarFacts(input: {
  facts: RadarGameFacts;
  boards: string[];
  score: number;
  detected: RadarSchedule;
  previousAction: string | null;
  todayIso: string;
}): Promise<RadarExtraction | null> {
  const f = input.facts;
  const payload = {
    today: input.todayIso,
    boards: input.boards,
    score: Math.round(input.score * 10) / 10,
    previousAction: input.previousAction,
    game: {
      appId: f.appId,
      title: f.title,
      tags: f.tags,
      developer: f.developer,
      publisher: f.publisher,
      rating: f.rating,
      reserveCount: f.reserveCount,
      downloadCount: f.downloadCount,
      fansCount: f.fansCount,
      installSizeMb: f.installSizeMb,
      online: f.online ?? null,
      tapTapFlag: f.flag ?? null,
      releaseDate: f.releaseDate ?? null,
      updateDate: f.updateDate ?? null,
      hints: f.hints ?? [],
      information: f.notes,
      developerNote: f.developerNote?.slice(0, 600) ?? null,
      officialPosts: (f.officialPosts ?? []).slice(0, 6).map((p) => ({
        date: p.date,
        title: p.title.slice(0, 80),
        summary: p.summary.slice(0, 160),
      })),
    },
    detectedSchedule: input.detected.label || null,
  };

  try {
    const res = await callLLM(systemPrompt(), JSON.stringify(payload, null, 2), 1200, { temperature: 0 });
    const data = parseJsonObject(res.content);
    const sched = (data.schedule && typeof data.schedule === "object" ? data.schedule : {}) as Record<string, unknown>;
    const kind = str(sched.kind) as ScheduleKind;
    const date = str(sched.date);
    return {
      titleEn: str(data.titleEn),
      genre: str(data.genre),
      publisher: str(data.publisher),
      insights: str(data.insights),
      flags: {
        liveService: bool(data.liveService, f.online !== false),
        offlineSingle: bool(data.offlineSingle),
        ugc: bool(data.ugc),
        sensitiveTheme: str(data.sensitiveTheme),
        nicheReason: str(data.nicheReason),
        aaaGraphics: bool(data.aaaGraphics),
        publishedInVn: bool(data.publishedInVn),
        vnIp: bool(data.vnIp),
        internationalRelease: bool(data.internationalRelease),
      },
      schedule: SCHEDULE_KINDS.has(kind)
        ? { kind, date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null, note: str(sched.note) }
        : null,
    };
  } catch (err) {
    console.warn(`[radar] extract failed appId=${f.appId}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Trường chính thức trên TapTap (flag, ngày ra mắt, hints, bài đăng) thắng; LLM chỉ lấp chỗ trống.
 * Game còn ở trạng thái đặt trước (flag = 1) không được coi là đã ra mắt.
 */
export function mergeSchedule(
  detected: RadarSchedule,
  llm: RadarExtraction["schedule"],
  facts: RadarGameFacts,
  todayIso: string,
): RadarSchedule {
  if (detected.kind && detected.kind !== "event") return detected;
  if (!llm) return detected;
  const reserveOnly = facts.flag === 1;
  let kind: ScheduleKind = llm.kind;
  if (reserveOnly && (kind === "launched" || kind === "open_beta")) {
    if (!llm.date || llm.date <= todayIso) return detected;
    kind = "launch_date";
  }
  if (kind === "launch_date" && llm.date && llm.date <= todayIso) {
    if (reserveOnly) return detected;
    kind = "launched";
  }
  const openBeta = /公测|open beta/i.test(llm.note);
  const label =
    kind === "launch_date" && openBeta && llm.date
      ? `Open beta ${formatViDate(llm.date)}`
      : scheduleLabel(kind, llm.date, todayIso);
  return { kind, date: llm.date, label, source: "llm", raw: llm.note.slice(0, 160) || null };
}

export const EMPTY_FLAGS: RadarFlags = {
  liveService: true,
  offlineSingle: false,
  ugc: false,
  sensitiveTheme: "",
  nicheReason: "",
  aaaGraphics: false,
  publishedInVn: false,
  vnIp: false,
  internationalRelease: false,
};
