import fs from "fs";
import path from "path";
import type { AnalysisContext } from "./analysis-context";
import type { RubricManifest } from "./rubric-manifest";
import type { LibraryResolvedEntry, LibraryRequestItem } from "../types";
import { appendPendingBatch } from "./libraries.service";
import { tagsForLibraryMatching, translateTags } from "../utils/tag-translator";

function keywordHaystack(ctx: AnalysisContext): string {
  const base = (ctx.searchHaystack ?? "").trim();
  const enTags = translateTags(ctx.tagValues).join(" ");
  return [base, enTags].filter(Boolean).join(" \n ");
}

function dataPath(...segs: string[]): string {
  return path.join(process.cwd(), "data", ...segs);
}

function loadJson<T>(name: string): T {
  const p = dataPath("libraries", name);
  return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
}

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\s+/g, " ")
    .trim();
}

interface GenreTierFile {
  version: number;
  defaultScore: number;
  tiers: Record<string, { label: string; score: number }>;
  tagPatterns: Array<{ match: string[]; tier: string }>;
  notesEditor?: string;
}

export interface StudioTierFile {
  version: number;
  neutralScore: number;
  entries: Array<{
    names: string[];
    tier?: string;
    score: number;
    roles?: string[];
  }>;
}

interface GameSizeLib {
  version: number;
  neutralScore: number;
  rules: Array<{ maxMb: number; score: number; label: string }>;
}

interface UpdateCycleLib {
  version: number;
  neutralScore: number;
  rules: Array<{ maxDaysSinceUpdate: number; score: number; label: string }>;
}

interface CommunityLib {
  version: number;
  neutralScore: number;
  fanTierRules: Array<{ minFans: number; score: number }>;
}

interface KeywordLib {
  version: number;
  neutralScore: number;
  keywordPatterns: Array<{ match: string[]; score: number }>;
}

export function inferGenrePack(tagValues: string[]): string | null {
  const tags = tagsForLibraryMatching(tagValues);
  const blob = normalizeName(tags.join(" "));
  if (!blob) return null;
  /** Genre chỉ là "Card" / 卡牌 / TCG (snapshot TapTap + DB) — blob regex cũ cần thêm "rpg"|"deck"... nên không khớp. */
  for (const tag of tags) {
    const n = normalizeName(tag);
    if (n === "card" || n === "卡牌" || n === "tcg" || n === "ccg" || n === "集换式卡牌") {
      return "cardRpg";
    }
  }
  // Extraction / looter trước (tránh “extraction” bị ăn vào nhánh card)
  if (
    /\bextraction\b|extraction shooter|tarkov|dark zone|looter|loot &|loots|evac|搜打撤|撤离|marathon|escape from|dmz mode|hunt: showdown|arena breakout|delta force/.test(
      blob,
    )
  ) {
    return "extraction";
  }
  if (/moba|arena|aov|wild rift|honor of kings|league|王者|liên quân|vainglory/.test(blob)) return "moba";
  if (/fps|shooter|battle royale|tps|gunplay|shooter game|shoot'em up|third-person shooter|first-person/.test(blob)) {
    return "shooter";
  }
  if (
    /card.?rpg|gacha rpg|idle.?rpg|trading card|ccg|tcg|deck builder|loot.?shoot|auto chess|squad rpg/.test(blob) ||
    (blob.includes("card") && (blob.includes("rpg") || blob.includes("battle") || blob.includes("deck")))
  ) {
    return "cardRpg";
  }
  return null;
}

export function scoreGenreFromTags(
  tagValues: string[],
  lib: GenreTierFile,
): { score: number; matched: string; confidence: "high" | "medium" } | null {
  let bestScore = -1;
  let bestMatched = "";

  const consider = (score: number, matched: string) => {
    if (score > bestScore) {
      bestScore = score;
      bestMatched = matched;
    }
  };

  for (const tag of tagValues) {
    const t = normalizeName(tag);
    if (!t) continue;
    for (const row of lib.tagPatterns) {
      for (const m of row.match) {
        const nm = normalizeName(m);
        if (!nm) continue;
        if (t.includes(nm) || nm.includes(t)) {
          const tierKey = row.tier;
          const sc = lib.tiers[tierKey]?.score;
          if (sc == null) continue;
          consider(sc, `${tag}->${tierKey}`);
        }
      }
    }
  }

  const blob = normalizeName(tagValues.join(" "));
  if (blob) {
    for (const row of lib.tagPatterns) {
      for (const m of row.match) {
        const nm = normalizeName(m);
        if (!nm) continue;
        if (nm.length < 2) continue;
        if (blob.includes(nm)) {
          const tierKey = row.tier;
          const sc = lib.tiers[tierKey]?.score;
          if (sc == null) continue;
          consider(sc, `∋"${m}"→${tierKey}`);
        }
      }
    }
  }

  if (bestScore < 0) return null;
  return { score: bestScore, matched: bestMatched, confidence: "high" };
}

export function matchStudioName(name: string | null, lib: StudioTierFile): { score: number; matched: string } | null {
  if (!name) return null;
  const n = normalizeName(name);
  for (const e of lib.entries) {
    for (const alias of e.names) {
      const a = normalizeName(alias);
      if (n.includes(a) || a.includes(n)) {
        return { score: e.score, matched: alias };
      }
    }
  }
  return null;
}

function scoreGameSizeMb(mb: number | null, lib: GameSizeLib): { score: number; matched: string } | null {
  if (mb == null || !Number.isFinite(mb) || mb <= 0) return null;
  const sorted = [...lib.rules].sort((a, b) => a.maxMb - b.maxMb);
  for (const r of sorted) {
    if (mb <= r.maxMb) return { score: r.score, matched: `${Math.round(mb)}MB→${r.label}` };
  }
  return null;
}

function scoreDaysSinceUpdate(days: number | null, lib: UpdateCycleLib): { score: number; matched: string } | null {
  if (days == null || !Number.isFinite(days) || days < 0) return null;
  const sorted = [...lib.rules].sort((a, b) => a.maxDaysSinceUpdate - b.maxDaysSinceUpdate);
  for (const r of sorted) {
    if (days <= r.maxDaysSinceUpdate) return { score: r.score, matched: `${Math.round(days)}d→${r.label}` };
  }
  return null;
}

function scoreFansCommunity(fans: number | null, lib: CommunityLib): { score: number; matched: string } | null {
  if (fans == null || !Number.isFinite(fans) || fans < 0) return null;
  const sorted = [...lib.fanTierRules].sort((a, b) => b.minFans - a.minFans);
  for (const r of sorted) {
    if (fans >= r.minFans) return { score: r.score, matched: `fans=${fans}` };
  }
  return null;
}

function bestKeywordScore(haystack: string, lib: KeywordLib): { score: number; matched: string } | null {
  const h = normalizeName(haystack);
  if (!h) return null;
  let best: { score: number; matched: string } | null = null;
  for (const row of lib.keywordPatterns) {
    for (const kw of row.match) {
      const k = normalizeName(kw);
      if (!k) continue;
      if (h.includes(k)) {
        if (!best || row.score > best.score) best = { score: row.score, matched: kw };
      }
    }
  }
  return best;
}

export function resolveLibraryScores(ctx: AnalysisContext, _manifest: RubricManifest): LibraryResolvedEntry[] {
  const genreLib = loadJson<GenreTierFile>("genre-tiers.json");
  const studioLib = loadJson<StudioTierFile>("studio-tiers.json");
  const gameSizeLib = loadJson<GameSizeLib>("game-size-tiers.json");
  const updateLib = loadJson<UpdateCycleLib>("update-cycle-tiers.json");
  const communityLib = loadJson<CommunityLib>("community-size-tiers.json");
  const ipLib = loadJson<KeywordLib>("ip-theme-tiers.json");
  const sysLib = loadJson<KeywordLib>("system-requirement-tiers.json");
  const artLib = loadJson<KeywordLib>("art-style-keywords.json");

  const out: LibraryResolvedEntry[] = [];

  const g = scoreGenreFromTags(tagsForLibraryMatching(ctx.tagValues), genreLib);
  if (g) {
    out.push({
      criterionId: "overview.genre",
      score: g.score,
      matchedKey: g.matched,
      confidence: g.confidence,
    });
  }

  const d = matchStudioName(ctx.developerName, studioLib);
  if (d) {
    out.push({
      criterionId: "overview.developer",
      score: d.score,
      matchedKey: d.matched,
      confidence: "high",
    });
  }

  const gs = scoreGameSizeMb(ctx.installSizeMb ?? null, gameSizeLib);
  if (gs) {
    out.push({
      criterionId: "overview.game_size",
      score: gs.score,
      matchedKey: gs.matched,
      confidence: "medium",
    });
  }

  const uc = scoreDaysSinceUpdate(ctx.daysSinceUpdate ?? null, updateLib);
  if (uc) {
    out.push({
      criterionId: "liveops.content_update_cycle",
      score: uc.score,
      matchedKey: uc.matched,
      confidence: "medium",
    });
  }

  const cs = scoreFansCommunity(ctx.fansCount ?? null, communityLib);
  if (cs) {
    out.push({
      criterionId: "socialization.community_size",
      score: cs.score,
      matchedKey: cs.matched,
      confidence: "medium",
    });
  }

  const haystack = keywordHaystack(ctx);
  const ip = bestKeywordScore(haystack, ipLib);
  if (ip) {
    out.push({
      criterionId: "overview.ip_theme",
      score: ip.score,
      matchedKey: `kw:${ip.matched}`,
      confidence: "low",
    });
  }

  const sy = bestKeywordScore(haystack, sysLib);
  if (sy) {
    out.push({
      criterionId: "overview.system_requirement",
      score: sy.score,
      matchedKey: `kw:${sy.matched}`,
      confidence: "low",
    });
  }

  const ar = bestKeywordScore(haystack, artLib);
  if (ar) {
    out.push({
      criterionId: "overview.art_style",
      score: ar.score,
      matchedKey: `kw:${ar.matched}`,
      confidence: "low",
    });
  }

  return out;
}

/** Rubric criteria used to attach AI-suggested scores to library pending rows. */
export type RubricScoreSource = {
  criteria: Array<{ id: string; score?: number | null }>;
};

const KIND_CRITERION: Record<string, string> = {
  studio: "overview.developer",
  game_size: "overview.game_size",
  update_signal: "liveops.content_update_cycle",
  community_signal: "socialization.community_size",
};

export function criterionScoreFromRubric(
  rubric: RubricScoreSource | undefined,
  criterionId: string,
): number | undefined {
  const row = rubric?.criteria.find((c) => c.id === criterionId);
  if (row?.score != null && Number.isFinite(row.score)) return row.score;
  return undefined;
}

function withSuggestedScore(
  kind: string,
  jsonSuggestion: Record<string, unknown>,
  rubric: RubricScoreSource | undefined,
  fallback?: number,
): Record<string, unknown> {
  const criterionId = KIND_CRITERION[kind];
  const ai = criterionId ? criterionScoreFromRubric(rubric, criterionId) : undefined;
  const score = ai ?? fallback;
  if (score != null && Number.isFinite(score)) {
    return { ...jsonSuggestion, score: Math.round(score) };
  }
  return jsonSuggestion;
}

export function buildLibraryRequests(
  ctx: AnalysisContext,
  resolved: LibraryResolvedEntry[],
  rubric?: RubricScoreSource,
): LibraryRequestItem[] {
  const byId = new Map(resolved.map((r) => [r.criterionId, r]));
  const neutralStudio = loadJson<StudioTierFile>("studio-tiers.json").neutralScore;
  const neutralGenre = loadJson<GenreTierFile>("genre-tiers.json").defaultScore;
  const req: LibraryRequestItem[] = [];

  if (ctx.tagValues.length > 0 && !byId.get("overview.genre")) {
    req.push({
      kind: "genre_tags",
      label: ctx.tagValues.slice(0, 8).join(", "),
      detailEn: `Tags could not be matched to genre-tiers.json after EN normalization (${neutralGenre} is the neutral score). Add EN keywords to tagPatterns[] or extend TAG_MAP in tag-translator for ZH tags.`,
      jsonSuggestion: {
        hint: "genre-tiers.json tagPatterns — EN keywords only.",
        examplePatternEn: "deck builder",
        exampleRow: { match: ["deck builder", "trading card"], tier: "S" },
      },
    });
  }

  if (ctx.developerName && !byId.get("overview.developer")) {
    req.push({
      kind: "studio",
      label: ctx.developerName,
      detailEn: `Developer name is not listed in studio-tiers.json. Merge adds an entry; score from AI rubric when available (fallback ${neutralStudio}).`,
      jsonSuggestion: withSuggestedScore(
        "studio",
        {
          names: [ctx.developerName],
          tier: "custom",
          roles: ["developer"],
        },
        rubric,
        neutralStudio,
      ),
    });
  }

  /* Skip pending rows when there is no actionable signal (no package MB, no update date, no fans). */

  if (
    ctx.installSizeMb != null &&
    ctx.installSizeMb > 0 &&
    !byId.get("overview.game_size")
  ) {
    req.push({
      kind: "game_size",
      label: `${Math.round(ctx.installSizeMb)} MB`,
      detailEn: `Install size ~${Math.round(ctx.installSizeMb)} MB did not map to any game-size-tiers.json bucket — edit rules (maxMb) or add a tier.`,
      jsonSuggestion: withSuggestedScore(
        "game_size",
        {
          hint: "data/libraries/game-size-tiers.json rules[]",
          maxMb: Math.ceil(ctx.installSizeMb),
        },
        rubric,
      ),
    });
  }

  if (
    ctx.daysSinceUpdate != null &&
    ctx.daysSinceUpdate >= 0 &&
    !byId.get("liveops.content_update_cycle")
  ) {
    req.push({
      kind: "update_signal",
      label: `~${Math.round(ctx.daysSinceUpdate)} days`,
      detailEn: `About ${Math.round(ctx.daysSinceUpdate)} days since last update did not map into update-cycle-tiers.json — add or adjust maxDaysSinceUpdate rules.`,
      jsonSuggestion: withSuggestedScore(
        "update_signal",
        {
          hint: "data/libraries/update-cycle-tiers.json",
          maxDaysSinceUpdate: Math.round(ctx.daysSinceUpdate),
        },
        rubric,
      ),
    });
  }

  if (ctx.fansCount != null && ctx.fansCount >= 0 && !byId.get("socialization.community_size")) {
    req.push({
      kind: "community_signal",
      label: `fans ${ctx.fansCount}`,
      detailEn: `fans_count=${ctx.fansCount} did not map to community-size-tiers.json (minFans tiers).`,
      jsonSuggestion: withSuggestedScore(
        "community_signal",
        { hint: "data/libraries/community-size-tiers.json fanTierRules", minFans: ctx.fansCount },
        rubric,
      ),
    });
  }

  return req;
}

/** Ghi toàn bộ yêu cầu vào pending-additions.json (trùng type+label sẽ bỏ qua). */
export function persistLibraryRequestsToFile(ctx: AnalysisContext, requests: LibraryRequestItem[]): void {
  if (requests.length === 0) return;
  const batch = requests.map((r) => ({
    type: r.kind,
    label: r.label,
    detailVi: r.detailEn,
    jsonSuggestion: r.jsonSuggestion,
    appId: ctx.appId,
    gameName: ctx.gameName,
  }));
  appendPendingBatch(batch);
}
