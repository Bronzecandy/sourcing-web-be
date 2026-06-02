/**
 * Apply a pending library suggestion into app DB library documents.
 */

import { type LibraryFileId } from "./library-registry";
import { getLibraryDocumentSync, putLibraryDocument } from "./library-store";

function readRaw(id: string): unknown {
  return getLibraryDocumentSync(id);
}

async function writeRaw(id: string, data: unknown, updatedBy?: string): Promise<void> {
  await putLibraryDocument(id, data, updatedBy);
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

export async function appendStudioTierEntryLocal(
  input: { names: string[]; score: number; tier?: string; roles?: string[] },
  updatedBy?: string,
): Promise<void> {
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
    roles: input.roles?.length ? input.roles : ["developer"],
  });
  await writeRaw("studio-tiers.json", data, updatedBy);
}

export async function appendGenreTagKeywords(match: string[], tier: string, updatedBy?: string): Promise<void> {
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
  await writeRaw("genre-tiers.json", data, updatedBy);
}

export async function appendKeywordPatternLib(
  id: LibraryFileId,
  match: string[],
  score: number,
  updatedBy?: string,
): Promise<void> {
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
  await writeRaw(id, data, updatedBy);
}

export async function appendGameSizeRule(
  maxMb: number,
  score: number,
  label: string,
  updatedBy?: string,
): Promise<void> {
  const data = readRaw("game-size-tiers.json") as {
    rules?: Array<{ maxMb: number; score: number; label: string }>;
  };
  const rules = data.rules ?? [];
  rules.push({ maxMb, score, label: label || `≤${maxMb} MB` });
  data.rules = rules;
  await writeRaw("game-size-tiers.json", data, updatedBy);
}

export async function appendUpdateCycleRule(
  maxDaysSinceUpdate: number,
  score: number,
  label: string,
  updatedBy?: string,
): Promise<void> {
  const data = readRaw("update-cycle-tiers.json") as {
    rules?: Array<{ maxDaysSinceUpdate: number; score: number; label: string }>;
  };
  const rules = data.rules ?? [];
  rules.push({ maxDaysSinceUpdate, score, label: label || `≤${maxDaysSinceUpdate}d` });
  data.rules = rules;
  await writeRaw("update-cycle-tiers.json", data, updatedBy);
}

export async function appendCommunityFanRule(minFans: number, score: number, updatedBy?: string): Promise<void> {
  const data = readRaw("community-size-tiers.json") as {
    fanTierRules?: Array<{ minFans: number; score: number }>;
  };
  const fanTierRules = data.fanTierRules ?? [];
  fanTierRules.push({ minFans, score });
  data.fanTierRules = fanTierRules;
  await writeRaw("community-size-tiers.json", data, updatedBy);
}

export type MergePendingBody = {
  score?: number;
  tier?: string;
  keywordsEn?: string;
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

export async function applyPendingToLibraryFiles(
  item: PendingItemShape,
  body: MergePendingBody,
  updatedBy?: string,
): Promise<void> {
  const j = item.jsonSuggestion ?? {};
  const tierScores = readGenreTierScores();
  const t = item.type;

  if (t === "studio") {
    const names = Array.isArray(j.names) ? (j.names as unknown[]).map(String) : [item.label];
    const score = resolveMergeScore(t, j, body, tierScores);
    if (score == null) throw new Error("score or tier required");
    const tier = typeof body.tier === "string" ? body.tier : typeof j.tier === "string" ? j.tier : "custom";
    await appendStudioTierEntryLocal({ names, score, tier }, updatedBy);
    return;
  }

  if (t === "genre_tags") {
    const tier = body.tier ?? (j.exampleRow as { tier?: string } | undefined)?.tier ?? "B";
    const kw = splitKeywords(body.keywordsEn ?? "");
    if (kw.length === 0) throw new Error("keywordsEn is required (comma-separated English keywords / patterns)");
    await appendGenreTagKeywords(kw, String(tier), updatedBy);
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
    await appendKeywordPatternLib(fileId, kw, score, updatedBy);
    return;
  }

  if (t === "game_size") {
    const maxMb = typeof body.maxMb === "number" ? body.maxMb : typeof j.maxMb === "number" ? j.maxMb : undefined;
    const score = resolveMergeScore(t, j, body, tierScores);
    if (maxMb == null || !Number.isFinite(maxMb)) throw new Error("maxMb required");
    if (score == null) throw new Error("score required");
    await appendGameSizeRule(maxMb, score, body.ruleLabel ?? String(j.label ?? `≤${maxMb} MB`), updatedBy);
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
    await appendUpdateCycleRule(maxDays, score, body.ruleLabel ?? "", updatedBy);
    return;
  }

  if (t === "community_signal") {
    const minFans =
      typeof body.minFans === "number" ? body.minFans : typeof j.minFans === "number" ? j.minFans : undefined;
    const score = resolveMergeScore(t, j, body, tierScores);
    if (minFans == null || !Number.isFinite(minFans)) throw new Error("minFans required");
    if (score == null) throw new Error("score required");
    await appendCommunityFanRule(minFans, score, updatedBy);
    return;
  }

  throw new Error(`Merge not supported for type: ${t}`);
}
