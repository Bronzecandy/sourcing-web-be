/**
 * Apply a pending library suggestion into data/libraries/*.json, then mark the row merged.
 */

import { libraryFilePath, type LibraryFileId } from "./library-registry";
import fs from "fs";

function readRaw(id: string): unknown {
  const text = fs.readFileSync(libraryFilePath(id), "utf-8");
  return JSON.parse(text) as unknown;
}

function writeRaw(id: string, data: unknown): void {
  fs.writeFileSync(libraryFilePath(id), `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function readGenreTierScores(): Record<string, number> {
  const g = readRaw("genre-tiers.json") as { tiers?: Record<string, { score?: number }> };
  const out: Record<string, number> = {};
  if (!g.tiers) return out;
  for (const [k, v] of Object.entries(g.tiers)) {
    if (typeof v?.score === "number") out[k] = v.score;
  }
  return out;
}

function splitKeywords(s: string): string[] {
  return s
    .split(/[,，、]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function appendStudioTierEntryLocal(input: { names: string[]; score: number; tier?: string }): void {
  const names = input.names.map((n) => n.trim()).filter(Boolean);
  if (names.length === 0) throw new Error("names required");
  const data = readRaw("studio-tiers.json") as {
    entries?: Array<{ names: string[]; score: number; tier?: string; roles?: string[] }>;
  };
  if (!data.entries) data.entries = [];
  data.entries.push({
    names,
    score: input.score,
    tier: input.tier ?? "custom",
    roles: ["developer"],
  });
  writeRaw("studio-tiers.json", data);
}

export function appendGenreTagKeywords(match: string[], tier: string): void {
  const data = readRaw("genre-tiers.json") as {
    tagPatterns?: Array<{ match: string[]; tier: string }>;
  };
  const patterns = data.tagPatterns ?? [];
  let row = patterns.find((p) => p.tier === tier);
  if (!row) {
    row = { tier, match: [] };
    patterns.push(row);
  }
  const seen = new Set(row.match.map((x) => x.toLowerCase()));
  for (const m of match) {
    const low = m.toLowerCase();
    if (!seen.has(low)) {
      row.match.push(m);
      seen.add(low);
    }
  }
  data.tagPatterns = patterns;
  writeRaw("genre-tiers.json", data);
}

export function appendKeywordPatternLib(id: LibraryFileId, match: string[], score: number): void {
  const data = readRaw(id) as { keywordPatterns?: Array<{ match: string[]; score: number }> };
  const patterns = data.keywordPatterns ?? [];
  let row = patterns.find((p) => p.score === score);
  if (!row) {
    row = { score, match: [] };
    patterns.push(row);
  }
  const seen = new Set(row.match.map((x) => x.toLowerCase()));
  for (const m of match) {
    const low = m.toLowerCase();
    if (!seen.has(low)) {
      row.match.push(m);
      seen.add(low);
    }
  }
  data.keywordPatterns = patterns;
  writeRaw(id, data);
}

export function appendGameSizeRule(maxMb: number, score: number, label: string): void {
  const data = readRaw("game-size-tiers.json") as {
    rules?: Array<{ maxMb: number; score: number; label: string }>;
  };
  const rules = data.rules ?? [];
  rules.push({ maxMb, score, label: label || `≤${maxMb} MB` });
  data.rules = rules;
  writeRaw("game-size-tiers.json", data);
}

export function appendUpdateCycleRule(maxDaysSinceUpdate: number, score: number, label: string): void {
  const data = readRaw("update-cycle-tiers.json") as {
    rules?: Array<{ maxDaysSinceUpdate: number; score: number; label: string }>;
  };
  const rules = data.rules ?? [];
  rules.push({ maxDaysSinceUpdate, score, label: label || `≤${maxDaysSinceUpdate}d` });
  data.rules = rules;
  writeRaw("update-cycle-tiers.json", data);
}

export function appendCommunityFanRule(minFans: number, score: number): void {
  const data = readRaw("community-size-tiers.json") as {
    fanTierRules?: Array<{ minFans: number; score: number }>;
  };
  const fanTierRules = data.fanTierRules ?? [];
  fanTierRules.push({ minFans, score });
  data.fanTierRules = fanTierRules;
  writeRaw("community-size-tiers.json", data);
}

export type MergePendingBody = {
  score?: number;
  tier?: string;
  /** Comma-separated English keywords for genre / IP / system / art merges */
  keywordsEn?: string;
  /** For game_size / update_cycle / community: numeric threshold fields */
  maxMb?: number;
  maxDaysSinceUpdate?: number;
  minFans?: number;
  ruleLabel?: string;
};

export type PendingItemShape = {
  type: string;
  label: string;
  jsonSuggestion: Record<string, unknown>;
};

/** Resolve a numeric score from body, jsonSuggestion, or tier → genre tier table. */
export function resolveMergeScore(
  itemType: string,
  j: Record<string, unknown>,
  body: MergePendingBody,
  tierScores: Record<string, number>,
): number | null {
  if (typeof body.score === "number" && Number.isFinite(body.score)) return body.score;
  if (typeof j.score === "number" && Number.isFinite(j.score)) return j.score;
  const tier = typeof body.tier === "string" ? body.tier : typeof j.tier === "string" ? j.tier : undefined;
  if (tier && tierScores[tier] != null) return tierScores[tier];
  if (itemType === "genre_tags") {
    const ex = j.exampleRow as { tier?: string } | undefined;
    const t = typeof ex?.tier === "string" ? ex.tier : undefined;
    if (t && tierScores[t] != null) return tierScores[t];
  }
  return null;
}

/**
 * Mutates the appropriate library JSON for this pending row. Caller marks pending merged after success.
 */
export function applyPendingToLibraryFiles(item: PendingItemShape, body: MergePendingBody): void {
  const j = item.jsonSuggestion ?? {};
  const tierScores = readGenreTierScores();
  const t = item.type;

  if (t === "studio") {
    const names = Array.isArray(j.names) ? (j.names as unknown[]).map(String) : [item.label];
    const score = resolveMergeScore(t, j, body, tierScores);
    if (score == null) throw new Error("score or tier required");
    const tier = typeof body.tier === "string" ? body.tier : typeof j.tier === "string" ? j.tier : "custom";
    appendStudioTierEntryLocal({ names, score, tier });
    return;
  }

  if (t === "genre_tags") {
    const tier = body.tier ?? (j.exampleRow as { tier?: string } | undefined)?.tier ?? "B";
    const kw = splitKeywords(body.keywordsEn ?? "");
    if (kw.length === 0) throw new Error("keywordsEn is required (comma-separated English keywords / patterns)");
    appendGenreTagKeywords(kw, String(tier));
    return;
  }

  if (t === "ip_theme" || t === "system_spec" || t === "art_style") {
    const fileId: LibraryFileId =
      t === "ip_theme"
        ? "ip-theme-tiers.json"
        : t === "system_spec"
          ? "system-requirement-tiers.json"
          : "art-style-keywords.json";
    const kw = splitKeywords(body.keywordsEn ?? "");
    if (kw.length === 0) throw new Error("keywordsEn is required");
    const score = resolveMergeScore(t, j, body, tierScores);
    if (score == null) throw new Error("score is required when the suggestion has no score");
    appendKeywordPatternLib(fileId, kw, score);
    return;
  }

  if (t === "game_size") {
    const maxMb = typeof body.maxMb === "number" ? body.maxMb : typeof j.maxMb === "number" ? j.maxMb : undefined;
    const score = resolveMergeScore(t, j, body, tierScores);
    if (maxMb == null || !Number.isFinite(maxMb)) throw new Error("maxMb required");
    if (score == null) throw new Error("score required");
    appendGameSizeRule(maxMb, score, body.ruleLabel ?? String(j.label ?? `≤${maxMb} MB`));
    return;
  }

  if (t === "update_signal") {
    const maxDays =
      typeof body.maxDaysSinceUpdate === "number"
        ? body.maxDaysSinceUpdate
        : typeof j.maxDaysSinceUpdate === "number"
          ? j.maxDaysSinceUpdate
          : undefined;
    const score = resolveMergeScore(t, j, body, tierScores);
    if (maxDays == null || !Number.isFinite(maxDays)) throw new Error("maxDaysSinceUpdate required");
    if (score == null) throw new Error("score required");
    appendUpdateCycleRule(maxDays, score, body.ruleLabel ?? "");
    return;
  }

  if (t === "community_signal") {
    const minFans =
      typeof body.minFans === "number" ? body.minFans : typeof j.minFans === "number" ? j.minFans : undefined;
    const score = resolveMergeScore(t, j, body, tierScores);
    if (minFans == null || !Number.isFinite(minFans)) throw new Error("minFans required");
    if (score == null) throw new Error("score required");
    appendCommunityFanRule(minFans, score);
    return;
  }

  throw new Error(`Merge not supported for type: ${t}`);
}
