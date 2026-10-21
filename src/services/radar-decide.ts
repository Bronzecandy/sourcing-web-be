import fs from "fs";
import path from "path";
import { jsonrepair } from "jsonrepair";
import { callLLM } from "../utils/ai-client";
import {
  NEXT_ACTIONS,
  actionFamily,
  isNextAction,
  type NextAction,
  type RadarDecision,
  type RadarGameFacts,
} from "./radar-types";

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

function snapAction(value: unknown, playableNow: boolean): NextAction {
  const text = typeof value === "string" ? value.trim() : "";
  if (isNextAction(text)) {
    if (text.startsWith("Test Viable") && !playableNow) {
      if (text.includes("High")) return "Monitor - High Potential";
      if (text.includes("Low")) return "Monitor - Low Potential";
      return "Monitor - Mid Potential";
    }
    if (!text.startsWith("Test Viable") && playableNow && text.startsWith("Monitor")) {
      if (text.includes("High")) return "Test Viable - High Potential";
      if (text.includes("Low")) return "Test Viable - Low Potential";
      return "Test Viable - Medium Potential";
    }
    return text;
  }
  const family = actionFamily(text);
  if (playableNow) {
    if (family === "high") return "Test Viable - High Potential";
    if (family === "low") return "Test Viable - Low Potential";
    if (family === "drop") return "Drop";
    if (family === "ignore") return "Temporary Ignore";
    if (family === "mid" || family === "viable") return "Test Viable - Medium Potential";
  }
  if (family === "high") return "Monitor - High Potential";
  if (family === "low") return "Monitor - Low Potential";
  if (family === "drop") return "Drop";
  if (family === "ignore") return "Temporary Ignore";
  if (family === "viable") return playableNow ? "Test Viable - Medium Potential" : "Monitor - Mid Potential";
  return "Monitor - Mid Potential";
}

export async function decideRadarGame(input: {
  facts: RadarGameFacts;
  boardLabel: string;
  rank: number;
  score: number;
  previousAction: string | null;
  previousDate: string | null;
}): Promise<RadarDecision> {
  const { facts } = input;
  const user = JSON.stringify(
    {
      board: input.boardLabel,
      rank: input.rank,
      score: input.score,
      previousAction: input.previousAction,
      previousDate: input.previousDate,
      game: facts,
      allowed: NEXT_ACTIONS,
    },
    null,
    2,
  );

  try {
    const res = await callLLM(systemPrompt(), user, 1200);
    const data = parseJsonObject(res.content);
    const playableNow = data.playableNow === true;
    const nextAction = snapAction(data.nextAction, playableNow);
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    return {
      titleEn: str(data.titleEn),
      insights: str(data.insights) || `${facts.title} nằm hạng ${input.rank} bảng ${input.boardLabel}.`,
      nextAction,
      reason: str(data.reason),
      releaseLabel: str(data.releaseLabel),
      playableNow: nextAction.startsWith("Test Viable"),
      genre: str(data.genre) || facts.tags.slice(0, 3).join(", "),
      publisher: str(data.publisher) || facts.publisher || facts.developer || "",
      toolAdjustments: str(data.toolAdjustments),
    };
  } catch (err) {
    console.warn(
      `[radar] decide failed appId=${facts.appId}:`,
      err instanceof Error ? err.message : err,
    );
    return {
      titleEn: "",
      insights: `${facts.title}: chưa research đủ kỳ này.`,
      nextAction: "Temporary Ignore",
      reason: "thiếu dữ liệu kỳ này",
      releaseLabel: "",
      playableNow: false,
      genre: facts.tags.slice(0, 3).join(", "),
      publisher: facts.publisher || facts.developer || "",
      toolAdjustments: "Game mới (chưa có ở recap kỳ trước)",
    };
  }
}

export async function writeExecutiveParagraphs(brief: string): Promise<string[]> {
  const system = [
    "Bạn viết Phần 3 Executive Summary của Game Radar Recap.",
    "Giọng nội bộ, tiếng Việt, 3 đến 5 đoạn ngắn.",
    "Nêu game đáng theo dõi, game chơi được ngay, lịch test mới, và game nên bỏ.",
    "Không kể công thức điểm. Không markdown. Trả JSON: {\"paragraphs\":[\"...\"]}",
  ].join(" ");
  try {
    const res = await callLLM(system, brief, 1600);
    const data = parseJsonObject(res.content);
    const paragraphs = Array.isArray(data.paragraphs)
      ? data.paragraphs.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      : [];
    if (paragraphs.length > 0) return paragraphs.map((p) => p.trim());
  } catch (err) {
    console.warn("[radar] executive summary failed:", err instanceof Error ? err.message : err);
  }
  return ["Kỳ này đã chốt Next Action theo ba bảng Reserve tăng trưởng, Reserve quy mô và New Launch. Chi tiết từng game nằm ở phần Overview."];
}
