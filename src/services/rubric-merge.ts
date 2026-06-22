import type {
  RubricAggregate,
  RubricBlock,
  RubricCriterionOutput,
  RubricPartRollup,
  LibraryResolvedEntry,
  RubricRedFlagBlock,
  RubricScoreSource,
  RedFlagSeverity,
  RedFlagAtAGlance,
  RedFlagsChecklist,
  GenrePackPlan,
  GenrePackRollup,
  GenrePackResolvedItem,
} from "../types";
import type { AnalysisContext } from "./analysis-context";
import type { RubricCriterionDef, RubricManifest } from "./rubric-manifest";
import { translateTags } from "../utils/tag-translator";

/** Gói base: toàn bộ 40% gameplay+genre dồn vào Gameplay; không có phần Theo thể loại. */
export const BASE_GAMEPLAY_PART_WEIGHT = 0.4;
/**
 * Gói thể loại riêng: Gameplay 10% + Theo thể loại 30% = 40% (thêm 2% từ Social so với manifest 24%+14%).
 * Phần pool còn lại (~60%) chia theo manifest; Social bị trừ 2% tuyệt đối trước khi scale.
 */
export const NON_BASE_GAMEPLAY_PART_WEIGHT = 0.1;
export const NON_BASE_GENRE_PART_WEIGHT = 0.3;
export const SOCIAL_WEIGHT_PENALTY = 0.02;

const NON_BASE_POOL_PART_IDS = ["overview", "presentation", "monetization", "socialization", "liveops"] as const;

function scalePoolParts(
  manifest: RubricManifest,
  remainder: number,
  socialPenalty: number,
): Map<string, number> {
  const manifestById = new Map(manifest.parts.map((p) => [p.id, p.weight]));
  let poolSum = 0;
  const adjusted = new Map<string, number>();
  for (const id of NON_BASE_POOL_PART_IDS) {
    let w = manifestById.get(id) ?? 0;
    if (id === "socialization" && socialPenalty > 0) {
      w = Math.max(0, w - socialPenalty);
    }
    adjusted.set(id, w);
    poolSum += w;
  }
  const out = new Map<string, number>();
  for (const id of NON_BASE_POOL_PART_IDS) {
    const w = adjusted.get(id) ?? 0;
    out.set(id, poolSum > 0 ? (w / poolSum) * remainder : 0);
  }
  return out;
}

/** Trọng số từng phần thực tế khi tính điểm tổng (sau khi cân theo gói thể loại). */
export function resolveEffectivePartWeights(manifest: RubricManifest, packResolved: string): Map<string, number> {
  const isBase = packResolved === "base";
  const out = new Map<string, number>();

  if (isBase) {
    out.set("gameplay", BASE_GAMEPLAY_PART_WEIGHT);
    out.set("genre_specific", 0);
    const pool = scalePoolParts(manifest, 1 - BASE_GAMEPLAY_PART_WEIGHT, 0);
    for (const [id, w] of pool) out.set(id, w);
    return out;
  }

  const gameplayGenreTotal = NON_BASE_GAMEPLAY_PART_WEIGHT + NON_BASE_GENRE_PART_WEIGHT;
  const pool = scalePoolParts(manifest, 1 - gameplayGenreTotal, SOCIAL_WEIGHT_PENALTY);
  for (const [id, w] of pool) out.set(id, w);
  out.set("gameplay", NON_BASE_GAMEPLAY_PART_WEIGHT);
  out.set("genre_specific", NON_BASE_GENRE_PART_WEIGHT);
  return out;
}

export function resolveGenrePackForWeights(
  inferredPack: string | null | undefined,
  manifest: RubricManifest,
): string {
  return inferredPack ?? manifest.genrePackDefault ?? "base";
}

export { resolveLibraryScores, normalizeName, scoreGenreFromTags, matchStudioName, inferGenrePack, inferAllGenrePacks, buildLibraryRequests, persistLibraryRequests } from "./library-resolve";

export interface LlmRubricRow {
  id: string;
  score: number | null;
  reasoning?: string;
  mentionCount?: number;
  strengths?: string[];
  weaknesses?: string[];
}

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Legacy LLM 0–100 “intensity” → mức severity (khi chưa có chuỗi severity) */
function mapNumericRedFlagToSeverity(n: number | null | undefined): RedFlagSeverity | null {
  if (n == null) return null;
  if (n <= 15) return "none";
  if (n <= 40) return "low";
  if (n <= 70) return "medium";
  return "high";
}

function parseSeverityString(v: unknown): RedFlagSeverity | null | undefined {
  if (v === null) return null;
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  if (s === "none" || s === "low" || s === "medium" || s === "high") return s;
  return undefined;
}

/** true/false từ LLM; null nếu không khai báo */
function triBool(v: unknown): boolean | null {
  if (v === true) return true;
  if (v === false) return false;
  return null;
}

/** Có rủi ro (ô “Có”) khi severity không phải none */
function severityToFlagPresent(s: RedFlagSeverity | null): boolean | null {
  if (s == null) return null;
  if (s === "none") return false;
  return true;
}

function parsePlayerMentions(raw: unknown): RubricRedFlagBlock["playerMentions"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const pick = (k: string): string | null | undefined => {
    const v = o[k];
    if (v == null) return null;
    if (typeof v !== "string") return undefined;
    const s = v.trim();
    return s.length > 0 ? s : null;
  };
  const mentions = {
    politics: pick("politics"),
    religion: pick("religion"),
    casino: pick("casino"),
    violence: pick("violence"),
    sexual: pick("sexual"),
    summary: pick("summary"),
  };
  const hasAny = Object.values(mentions).some((v) => typeof v === "string" && v.length > 0);
  return hasAny ? mentions : undefined;
}

function buildRedFlagBlock(raw: Record<string, unknown> | null | undefined): RubricRedFlagBlock {
  const r = raw ?? {};
  const politics = triBool(r.politics);
  const casino = triBool(r.casino);
  const religionSensitive = triBool(r.religionSensitive ?? r.religion ?? r.religiousTaboo);
  const note = typeof r.otherTaboosNote === "string" ? r.otherTaboosNote : undefined;

  const vsStr = parseSeverityString(r.violenceSeverity);
  const ssStr = parseSeverityString(r.sexualSeverity);
  const vsNum =
    typeof r.violenceScore === "number"
      ? clampScore(r.violenceScore)
      : r.violenceScore === null
        ? null
        : undefined;
  const ssNum =
    typeof r.sexualScore === "number"
      ? clampScore(r.sexualScore)
      : r.sexualScore === null
        ? null
        : undefined;

  const violenceSeverity: RedFlagSeverity | null =
    vsStr !== undefined ? vsStr : mapNumericRedFlagToSeverity(vsNum);
  const sexualSeverity: RedFlagSeverity | null =
    ssStr !== undefined ? ssStr : mapNumericRedFlagToSeverity(ssNum);

  return {
    politics,
    casino,
    religionSensitive,
    violenceSeverity,
    sexualSeverity,
    violenceScore: vsNum,
    sexualScore: ssNum,
    otherTaboosNote: note,
    playerMentions: parsePlayerMentions(r.playerMentions),
  };
}

/** Gộp bằng chứng từ rubricCriteria red_flag.* khi LLM không trả playerMentions đủ. */
export function mergeRedFlagPlayerMentions(
  rf: RubricRedFlagBlock,
  criteria: RubricCriterionOutput[],
): RubricRedFlagBlock["playerMentions"] {
  const fromCriteria: NonNullable<RubricRedFlagBlock["playerMentions"]> = {};
  for (const c of criteria) {
    if (c.partId !== "red_flag") continue;
    const parts = [c.reasoning, ...(c.weaknesses ?? [])].map((s) => s?.trim()).filter(Boolean) as string[];
    if (parts.length === 0) continue;
    const text = parts.join(" ");
    switch (c.id) {
      case "red_flag.politics":
        fromCriteria.politics = text;
        break;
      case "red_flag.religion":
        fromCriteria.religion = text;
        break;
      case "red_flag.casino":
        fromCriteria.casino = text;
        break;
      case "red_flag.violence":
        fromCriteria.violence = text;
        break;
      case "red_flag.sexual":
        fromCriteria.sexual = text;
        break;
      default:
        break;
    }
  }
  const llm = rf.playerMentions ?? {};
  return {
    politics: llm.politics ?? fromCriteria.politics ?? null,
    religion: llm.religion ?? fromCriteria.religion ?? null,
    casino: llm.casino ?? fromCriteria.casino ?? null,
    violence: llm.violence ?? fromCriteria.violence ?? null,
    sexual: llm.sexual ?? fromCriteria.sexual ?? null,
    summary: llm.summary ?? null,
  };
}

const LIBRARY_OVERRIDE_IDS = new Set([
  "overview.genre",
  "overview.developer",
  "overview.game_size",
  "overview.ip_theme",
  "overview.system_requirement",
  "overview.art_style",
  "socialization.community_size",
  "liveops.content_update_cycle",
]);

function normalizeStringList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.map((x) => String(x).trim()).filter((s) => s.length > 0);
  return out.length > 0 ? out : undefined;
}

export function mergeRubricFromLlm(
  manifest: RubricManifest,
  activeCriteria: RubricCriterionDef[],
  libraryEntries: LibraryResolvedEntry[],
  llmRows: LlmRubricRow[] | null | undefined,
  redFlagRaw: Record<string, unknown> | null | undefined,
  reviewCount: number,
  /** Gói rubric + trọng số; null → base. */
  genrePackPlan?: GenrePackPlan | null,
): RubricBlock {
  const libById = new Map(libraryEntries.map((e) => [e.criterionId, e]));
  const llmById = new Map((llmRows ?? []).map((r) => [r.id, r]));
  const redFlag = buildRedFlagBlock(redFlagRaw ?? undefined);

  const criteriaOut: RubricCriterionOutput[] = [];

  for (const def of activeCriteria) {
    const lib = libById.get(def.id);
    const llm = llmById.get(def.id);

    let score: number | null = null;
    let reasoning: string | undefined;
    let mentionCount: number | undefined;
    let source: RubricScoreSource = "llm";
    let confidence: "high" | "medium" | "low" | undefined;
    let matchedLibraryKey: string | undefined;

    if (lib && LIBRARY_OVERRIDE_IDS.has(def.id)) {
      score = clampScore(lib.score);
      reasoning =
        def.input === "page_lib"
          ? `Thư viện: khớp "${lib.matchedKey}" (${def.elementVi}).`
          : undefined;
      source = "library";
      confidence = lib.confidence;
      matchedLibraryKey = lib.matchedKey;
    } else if (llm && typeof llm.score === "number") {
      score = clampScore(llm.score);
      reasoning = typeof llm.reasoning === "string" ? llm.reasoning : undefined;
      mentionCount = typeof llm.mentionCount === "number" ? llm.mentionCount : undefined;
      source = "llm";
    } else if (llm && llm.score === null) {
      score = null;
      reasoning = typeof llm.reasoning === "string" ? llm.reasoning : "Không đủ review nhắc tới hoặc không xác định.";
      source = "llm";
    } else if (lib && !LIBRARY_OVERRIDE_IDS.has(def.id)) {
      score = clampScore(lib.score);
      source = "library";
      matchedLibraryKey = lib.matchedKey;
      confidence = lib.confidence;
    } else {
      score = null;
      reasoning = "Chưa có điểm từ LLM hoặc thư viện.";
      source = "merged";
    }

    const row: RubricCriterionOutput = {
      id: def.id,
      partId: def.partId,
      elementVi: def.elementVi,
      input: def.input,
      weightInPart: def.weightInPart,
      genrePack: def.genrePack ?? undefined,
      score,
      reasoning,
      mentionCount,
      strengths: llm ? normalizeStringList(llm.strengths) : undefined,
      weaknesses: llm ? normalizeStringList(llm.weaknesses) : undefined,
      source,
      confidence,
      matchedLibraryKey,
    };

    if (lib && LIBRARY_OVERRIDE_IDS.has(def.id) && llm?.reasoning) {
      row.reasoning = `${row.reasoning ?? ""} ${llm.reasoning}`.trim();
      row.source = "merged";
    }

    if (def.partId === "red_flag") {
      row.score = null;
      const rf = redFlag;
      switch (def.id) {
        case "red_flag.violence": {
          const s = rf.violenceSeverity ?? null;
          row.severity = s;
          row.flagPresent = severityToFlagPresent(s);
          break;
        }
        case "red_flag.sexual": {
          const s = rf.sexualSeverity ?? null;
          row.severity = s;
          row.flagPresent = severityToFlagPresent(s);
          break;
        }
        case "red_flag.politics":
          row.flagPresent = rf.politics ?? null;
          break;
        case "red_flag.casino":
          row.flagPresent = rf.casino ?? null;
          break;
        case "red_flag.religion":
          row.flagPresent = rf.religionSensitive ?? null;
          break;
        default:
          break;
      }
    }

    applySocialCriterionGuards(row, llm);

    criteriaOut.push(row);
  }

  const threshold = 10;
  const plan =
    genrePackPlan ??
    ({
      packs: [{ packId: resolveGenrePackForWeights(null, manifest), weight: 1 }],
      reasoning: "",
      ratioPreset: null,
    } satisfies GenrePackPlan);

  const nonBasePacks = plan.packs.filter((p) => p.packId !== "base");
  const primaryPack =
    nonBasePacks.length > 0
      ? [...nonBasePacks].sort((a, b) => b.weight - a.weight)[0].packId
      : resolveGenrePackForWeights(null, manifest);

  const criteriaDefsById = new Map(activeCriteria.map((d) => [d.id, d]));
  const aggregate =
    nonBasePacks.length > 1
      ? computeMultiPackAggregate(manifest, criteriaOut, criteriaDefsById, redFlag, plan)
      : computeAggregate(
          manifest,
          criteriaOut,
          redFlag,
          resolveEffectivePartWeights(manifest, primaryPack),
        );

  const dataConfidence = {
    reviewCount,
    meetsThreshold: reviewCount >= threshold,
    threshold,
  };

  const genrePackRollups =
    nonBasePacks.length > 0
      ? buildGenrePackRollups(criteriaOut, nonBasePacks, criteriaDefsById)
      : undefined;

  return {
    manifestVersion: manifest.version,
    genrePackResolved: primaryPack,
    genrePacksResolved: plan.packs.map((p) => ({ packId: p.packId, weight: p.weight, labelVi: p.labelVi })),
    genrePackBlendReasoning: plan.reasoning || undefined,
    genrePackRollups,
    criteria: criteriaOut,
    aggregate,
    redFlag,
    dataConfidence,
  };
}

function partScoreFromCriteria(list: RubricCriterionOutput[]): { score: number | null; den: number } {
  let num = 0;
  let den = 0;
  for (const c of list) {
    if (c.score == null) continue;
    num += c.score * c.weightInPart;
    den += c.weightInPart;
  }
  return { score: den > 0 ? num / den : null, den };
}

function buildGenrePackRollups(
  criteria: RubricCriterionOutput[],
  packs: GenrePackResolvedItem[],
  criteriaDefsById: Map<string, RubricCriterionDef>,
): GenrePackRollup[] {
  const genreByPack = new Map<string, RubricCriterionOutput[]>();
  for (const p of packs) genreByPack.set(p.packId, []);
  for (const c of criteria) {
    if (c.partId !== "genre_specific") continue;
    const def = criteriaDefsById.get(c.id);
    const packId = def?.genrePack ?? c.genrePack;
    if (packId && genreByPack.has(packId)) {
      genreByPack.get(packId)!.push(c);
    }
  }
  return packs.map(({ packId, weight, labelVi }) => {
    const { score } = partScoreFromCriteria(genreByPack.get(packId) ?? []);
    return {
      packId,
      weight,
      labelVi,
      averageScore: score != null ? Math.round(score * 100) / 100 : null,
    };
  });
}

function computeMultiPackAggregate(
  manifest: RubricManifest,
  criteria: RubricCriterionOutput[],
  criteriaDefsById: Map<string, RubricCriterionDef>,
  redFlag: RubricRedFlagBlock,
  plan: GenrePackPlan,
): RubricAggregate {
  const nonBasePacks = plan.packs.filter((p) => p.packId !== "base");
  const templatePack = nonBasePacks[0]?.packId ?? "base";
  const effectivePartWeights = resolveEffectivePartWeights(manifest, templatePack);

  const byPart = new Map<string, RubricCriterionOutput[]>();
  for (const c of criteria) {
    if (c.partId === "red_flag") continue;
    if (!byPart.has(c.partId)) byPart.set(c.partId, []);
    byPart.get(c.partId)!.push(c);
  }

  const genreByPack = new Map<string, RubricCriterionOutput[]>();
  for (const p of nonBasePacks) genreByPack.set(p.packId, []);
  for (const c of byPart.get("genre_specific") ?? []) {
    const def = criteriaDefsById.get(c.id);
    const packId = def?.genrePack ?? c.genrePack;
    if (packId && genreByPack.has(packId)) {
      genreByPack.get(packId)!.push(c);
    }
  }

  let blendNum = 0;
  let blendWeightSum = 0;
  for (const { packId, weight } of nonBasePacks) {
    const { score, den } = partScoreFromCriteria(genreByPack.get(packId) ?? []);
    if (score != null && den > 0) {
      blendNum += score * weight;
      blendWeightSum += weight;
    }
  }
  const blendedGenreScore = blendWeightSum > 0 ? blendNum / blendWeightSum : null;

  let sumParts = 0;
  let weightSum = 0;
  const partRollups: RubricPartRollup[] = [];

  for (const part of manifest.parts) {
    if (part.id === "red_flag") continue;
    const wEff = effectivePartWeights.get(part.id) ?? 0;
    if (wEff <= 0) continue;

    let partScore: number | null;
    let den = 0;
    if (part.id === "genre_specific") {
      partScore = blendedGenreScore;
      if (partScore != null) {
        for (const p of nonBasePacks) {
          den += partScoreFromCriteria(genreByPack.get(p.packId) ?? []).den;
        }
      }
    } else {
      const scored = partScoreFromCriteria(byPart.get(part.id) ?? []);
      partScore = scored.score;
      den = scored.den;
    }

    const includedInGlobalScore = part.id === "genre_specific" ? partScore != null : den > 0;
    const numeratorContribution =
      includedInGlobalScore && partScore != null ? partScore * wEff : null;

    partRollups.push({
      partId: part.id,
      labelVi: part.labelVi,
      weightInTotal: wEff,
      manifestWeightInTotal: part.weight,
      partAverageScore: partScore != null ? Math.round(partScore * 100) / 100 : null,
      scoredWeightSumInPart: den,
      includedInGlobalScore,
      numeratorContribution,
    });

    if (!includedInGlobalScore) continue;
    sumParts += partScore! * wEff;
    weightSum += wEff;
  }

  return finalizeAggregate(partRollups, sumParts, weightSum, criteria, redFlag);
}

function finalizeAggregate(
  partRollups: RubricPartRollup[],
  sumParts: number,
  weightSum: number,
  criteria: RubricCriterionOutput[],
  redFlag: RubricRedFlagBlock,
): RubricAggregate {
  const redHard = redFlag.politics === true || redFlag.casino === true;
  const weightedScore = weightSum > 0 ? Math.round(sumParts / weightSum) : null;
  const band5 =
    weightedScore == null ? null : Math.max(1, Math.min(5, Math.ceil(weightedScore / 20)));

  let decision: RubricAggregate["decision"];
  if (redHard) {
    decision = "blocked_red_flag";
  } else if (weightedScore == null) {
    decision = "no_test";
  } else if (weightedScore < 50) {
    decision = "no_test";
  } else if (weightedScore < 75) {
    decision = "consider_test";
  } else if (weightedScore <= 90) {
    decision = "suitable_test";
  } else {
    decision = "must_test";
  }

  const lowScoreCriteriaCount = criteria.filter(
    (c) => c.partId !== "red_flag" && c.score != null && c.score < 30,
  ).length;

  return {
    weightedScore,
    band5,
    decision,
    lowScoreCriteriaCount,
    redFlagHardGate: redHard,
    partRollups,
    globalWeightDenominator: weightSum > 0 ? weightSum : undefined,
  };
}

function computeAggregate(
  manifest: RubricManifest,
  criteria: RubricCriterionOutput[],
  redFlag: RubricRedFlagBlock,
  effectivePartWeights: Map<string, number>,
): RubricAggregate {
  const byPart = new Map<string, RubricCriterionOutput[]>();
  for (const c of criteria) {
    if (c.partId === "red_flag") continue;
    if (!byPart.has(c.partId)) byPart.set(c.partId, []);
    byPart.get(c.partId)!.push(c);
  }

  let sumParts = 0;
  let weightSum = 0;
  const partRollups: RubricPartRollup[] = [];

  for (const part of manifest.parts) {
    if (part.id === "red_flag") continue;
    const wEff = effectivePartWeights.get(part.id) ?? 0;
    if (wEff <= 0) continue;
    const list = byPart.get(part.id) ?? [];
    let num = 0;
    let den = 0;
    for (const c of list) {
      if (c.score == null) continue;
      num += c.score * c.weightInPart;
      den += c.weightInPart;
    }
    const includedInGlobalScore = den > 0;
    const partScore = includedInGlobalScore ? num / den : null;
    const numeratorContribution =
      includedInGlobalScore && partScore != null ? partScore * wEff : null;

    partRollups.push({
      partId: part.id,
      labelVi: part.labelVi,
      weightInTotal: wEff,
      manifestWeightInTotal: part.weight,
      partAverageScore:
        partScore != null ? Math.round(partScore * 100) / 100 : null,
      scoredWeightSumInPart: den,
      includedInGlobalScore,
      numeratorContribution,
    });

    if (!includedInGlobalScore) continue;
    sumParts += partScore! * wEff;
    weightSum += wEff;
  }

  return finalizeAggregate(partRollups, sumParts, weightSum, criteria, redFlag);
}

function buildRedFlagDetailLines(
  rf: RubricRedFlagBlock,
  mentions: RubricRedFlagBlock["playerMentions"],
): string[] {
  const lines: string[] = [];
  const add = (label: string, active: boolean, text: string | null | undefined) => {
    if (!active || !text?.trim()) return;
    lines.push(`${label}: ${text.trim()}`);
  };
  add("Chính trị / chủ quyền", rf.politics === true, mentions?.politics);
  add("Tôn giáo nhạy cảm", rf.religionSensitive === true, mentions?.religion);
  add("Casino / cờ bạc đổi thưởng", rf.casino === true, mentions?.casino);
  const violActive = rf.violenceSeverity != null && rf.violenceSeverity !== "none";
  const sexActive = rf.sexualSeverity != null && rf.sexualSeverity !== "none";
  add(
    `Bạo lực gore (${rf.violenceSeverity ?? "n/a"})`,
    violActive,
    mentions?.violence,
  );
  add(
    `Sexual / gợi dục (${rf.sexualSeverity ?? "n/a"})`,
    sexActive,
    mentions?.sexual,
  );
  return lines;
}

/** Tóm tắt gắn đầu response API để client hiển thị red flag trước phần đánh giá chi tiết. */
export function buildRedFlagAtAGlance(rubric: RubricBlock): RedFlagAtAGlance {
  const rf = rubric.redFlag;
  const mentions = mergeRedFlagPlayerMentions(rf, rubric.criteria);
  const politics = rf.politics ?? null;
  const casino = rf.casino ?? null;
  const religion = rf.religionSensitive ?? null;
  const viol = rf.violenceSeverity ?? null;
  const sex = rf.sexualSeverity ?? null;
  const note = rf.otherTaboosNote?.trim() || null;

  const rank = (s: RedFlagSeverity | null): number =>
    s == null ? -1 : { none: 0, low: 1, medium: 2, high: 3 }[s];

  const maxRank = Math.max(rank(viol), rank(sex));

  const blockedByHardGate = politics === true || casino === true;

  let riskLevel: RedFlagAtAGlance["riskLevel"] = "clear";
  if (blockedByHardGate) riskLevel = "critical";
  else if (religion === true || maxRank >= 3) riskLevel = "high";
  else if (maxRank === 2) riskLevel = "medium";
  else if (maxRank === 1) riskLevel = "low";

  const hasElevatedRisk =
    blockedByHardGate ||
    religion === true ||
    maxRank >= 2 ||
    Boolean(note);

  let headlineVi: string;
  if (blockedByHardGate) {
    const bits: string[] = [];
    if (politics === true) bits.push("chính trị / chủ quyền");
    if (casino === true) bits.push("cờ bạc đổi thưởng");
    headlineVi = `Hard gate: ${bits.join(" + ")} — không phù hợp theo chính sách / thị trường VN.`;
  } else if (religion === true) {
    headlineVi =
      "Red flag: nội dung tôn giáo nhạy cảm / cực đoan — cần rà soát khi phát hành VN.";
  } else if (maxRank >= 3) {
    const parts: string[] = [];
    if (viol === "high") parts.push("bạo lực gore / mang rợ cao");
    if (sex === "high") parts.push("sexual / gợi dục cao");
    headlineVi = `Red flag nội dung: ${parts.join(", ") || "rủi ro cao"} — cần rà soát pháp lý & định vị thị trường VN.`;
  } else if (maxRank === 2) {
    headlineVi = `Cảnh báo: nội dung nhạy cảm mức trung bình (bạo lực=${viol ?? "n/a"}, sexual=${sex ?? "n/a"}).`;
  } else if (maxRank === 1) {
    headlineVi = `Rủi ro thấp: có yếu tố nhẹ; thường theo dõi thêm khi phát hành VN (violence=${viol ?? "-"}, sexual=${sex ?? "-"}).`;
  } else {
    headlineVi = `Chưa có hard gate politics/casino; bạo lực gore / sexual: ${viol ?? "chưa rõ"} / ${sex ?? "chưa rõ"} — tham chiếu compliance.`;
  }

  let detailVi = buildRedFlagDetailLines(rf, mentions);

  if (mentions?.summary?.trim()) {
    headlineVi = mentions.summary.trim();
  } else if (detailVi.length > 0 && hasElevatedRisk) {
    headlineVi = `${headlineVi} — ${detailVi[0]}`.trim();
    detailVi = detailVi.slice(1);
  } else if (note && !blockedByHardGate) {
    const short = note.length > 220 ? `${note.slice(0, 220)}…` : note;
    headlineVi = `${headlineVi} Taboo khác: ${short}`;
  }

  return {
    headlineVi: headlineVi.trim(),
    detailVi,
    playerMentions: mentions,
    riskLevel,
    blockedByHardGate,
    hasElevatedRisk,
    politics,
    religion,
    casino,
    violenceSeverity: viol,
    sexualSeverity: sex,
    otherTaboosNote: note,
  };
}

/** Checklist Có/Không — bind trực tiếp ô điểm trên FE */
export function buildRedFlagsChecklist(rubric: RubricBlock): RedFlagsChecklist {
  const rf = rubric.redFlag;
  const concern = (s: RedFlagSeverity | null | undefined): boolean | null => {
    if (s == null) return null;
    return s !== "none";
  };
  return {
    politics: rf.politics ?? null,
    religion: rf.religionSensitive ?? null,
    casino: rf.casino ?? null,
    violenceConcern: concern(rf.violenceSeverity),
    sexualConcern: concern(rf.sexualSeverity),
  };
}

export function formatLibraryScoresForPrompt(entries: LibraryResolvedEntry[]): string {
  if (entries.length === 0) {
    return "Điểm thư viện: chưa khớp mục nào từ genre/developer/size/lib khác — các tiêu chí page_lib sẽ do LLM xử lý theo quy tắc trong prompt (có chọn lọc).";
  }
  const lines = entries.map(
    (e) =>
      `- ${e.criterionId}: ${e.score}/100 (khớp: ${e.matchedKey}, độ tin: ${e.confidence})`,
  );
  return [
    "Điểm từ THƯ VIỆN JSON (ưu tiên giữ nguyên điểm khi đã khớp):",
    ...lines,
  ].join("\n");
}

export function formatContextForPrompt(ctx: AnalysisContext): string {
  const tags = ctx.tagValues.length ? ctx.tagValues.join(", ") : "(không có tag)";
  const tagsEn = translateTags(ctx.tagValues).join(", ") || "(none)";
  const mb =
    ctx.installSizeMb != null && ctx.installSizeMb > 0
      ? `${Math.round(ctx.installSizeMb * 10) / 10} MB`
      : "(không có)";
  const upd =
    ctx.daysSinceUpdate != null && ctx.daysSinceUpdate >= 0
      ? `~${Math.round(ctx.daysSinceUpdate)} ngày`
      : "(không có)";
  const fans = ctx.fansCount != null && ctx.fansCount >= 0 ? String(ctx.fansCount) : "(không có)";
  const devFb =
    ctx.developerResolvedViaPublisherFallback &&
    ctx.developerName &&
    ctx.publisherName &&
    ctx.developerName === ctx.publisherName
      ? " — ghi chú: snapshot không có field developer riêng; đang dùng publisher/vận hành làm tên tham chiếu cho tiêu chí Developer."
      : "";
  return [
    `Ngữ cảnh game (metadata snapshot — TapTap app detail, Steam Store appdetails, hoặc AppRank trong DB):`,
    `- Tên: ${ctx.gameName}`,
    `- Tag (DB / snapshot): ${tags}`,
    `- Tags mapped to English (tag-translator TAG_MAP → aligns English genre lib): ${tagsEn}`,
    `- Developer (ưu tiên cho overview.developer — có thể trùng publisher khi API chỉ khai báo một đơn vị): ${ctx.developerName ?? "(không có)"}${devFb}`,
    `- Publisher (snapshot): ${ctx.publisherName ?? "(không có)"}`,
    `- Tiêu chí overview.developer: nếu có tên Developer hoặc Publisher ở trên, phải cho điểm 0–100 + đánh giá uy tín/năng lực (research có kiểm soát từ kiến thức chung + review); không để score null chỉ vì không khớp file studio-tiers.`,
    `- Dung lượng gói (MB, nếu có trong raw): ${mb}`,
    `- Ngày từ lần cập nhật snapshot (update_time): ${upd}`,
    `- fans_count (snapshot): ${fans}`,
    `- Tiêu chí socialization.community_size: nếu fans_count là "(không có)" hoặc không khớp thư viện, **bắt buộc** research công khai (Google Trends, Steam reviews/player estimates, Discord/Reddit/sub, forum TapTap, báo chí/benchmark game cùng IP) để ước lượng quy mô cộng đồng và cho điểm 0–100; ghi rõ nguồn suy luận trong reasoning; **không** để score null chỉ vì thiếu snapshot.`,
  ].join("\n");
}

export function formatRubricCriteriaForPrompt(active: RubricCriterionDef[]): string {
  return active
    .map(
      (c) =>
        `- id "${c.id}" | ${c.elementVi} | input=${c.input} | gợi ý: ${c.promptHint}`,
    )
    .join("\n");
}

const RED_FLAG_OUTPUT_SPEC = `
Red Flag — đánh giá rủi ro / phù hợp thị trường Việt Nam (KHÔNG là điểm rubric, KHÔNG làm thay đổi weightedScore; part red_flag có weight 0):
- Trả "redFlagSignals" với politics, casino (boolean) và violenceSeverity, sexualSeverity: một trong "none" | "low" | "medium" | "high" hoặc null (null = không đủ dữ liệu để phân loại).
- BẮT BUỘC "playerMentions" trong redFlagSignals: mô tả tiếng Việt **cách người chơi đề cập** từng vấn đề trong review (paraphrase, không bịa quote; ước lượng số review nhắc tới nếu có). Chỉ điền field tương ứng khi có bằng chứng hoặc mức rủi ro ≠ none/false; null nếu không nhắc.
- "playerMentions.summary": 1–2 câu tóm tắt rủi ro chính cho alert UI (rõ, cụ thể, không chung chung).
- Ưu tiên severity; không bắt buộc violenceScore/sexualScore (0–100). Nếu chỉ có số cũ, hệ thống vẫn suy ra severity.
- Trong "rubricCriteria", các id bắt đầu bằng "red_flag.": đặt "score": null (bắt buộc); reasoning/weaknesses phải nêu **người chơi phàn nàn / nhắc gì** (paraphrase review).
- violenceSeverity: chỉ nâng mức khi có bạo lực mang rợ, máu me, kinh dị thể chất, tra tấn, phân thân rõ (gore). Game hành động / đối kháng / bắn súng / combat nhiều mà không có hình ảnh gây sốc như trên → coi là none hoặc low, không vì “đánh nhau nhiều” mà gán medium/high.
- sexualSeverity: gợi dục, nội dung tình dục, nudity — mức rủi ro cho VN.
- politics: nội dung chính trị nhạy cảm, chủ quyền, bản đồ, tuyên truyền tranh chấp với VN.
- casino: cờ bạc đổi thưởng tiền thật / casino.
- religionSensitive (boolean hoặc bỏ trống): tôn giáo nhạy cảm, cực đoan, nội dung phản cảm tôn giáo liên quan thị trường VN.
`;

const RUBRIC_JSON_SPEC = `
, "rubricCriteria": [
  {
    "id": "<một trong các id rubric>",
    "score": <số 0-100, hoặc null — với id "red_flag.*" luôn null>,
    "reasoning": "1 câu tiếng Việt",
    "mentionCount": <số nguyên ≥0, ước lượng số review có liên quan>,
    "strengths": ["mỗi phần tử 1 điểm mạnh ngắn tiếng Việt theo ĐÚNG tiêu chí này", "..."],
    "weaknesses": ["mỗi phần tử 1 điểm yếu ngắn tiếng Việt theo ĐÚNG tiêu chí này", "..."]
  }
],
"redFlagSignals": {
  "politics": <boolean | bỏ qua nếu không rõ>,
  "casino": <boolean | bỏ qua nếu không rõ>,
  "religionSensitive": <boolean | bỏ qua nếu không rõ>,
  "violenceSeverity": <"none"|"low"|"medium"|"high"|null>,
  "sexualSeverity": <"none"|"low"|"medium"|"high"|null>,
  "violenceScore": <tùy chọn, legacy 0-100 hoặc null>,
  "sexualScore": <tùy chọn, legacy 0-100 hoặc null>,
  "otherTaboosNote": <string hoặc null>,
  "playerMentions": {
    "summary": <string | null — tóm tắt alert>,
    "politics": <string | null>,
    "religion": <string | null>,
    "casino": <string | null>,
    "violence": <string | null>,
    "sexual": <string | null>
  }
}
Phải có đủ một object trong rubricCriteria cho MỖI id rubric được liệt kê ở trên. Với mỗi tiêu chí: strengths/weaknesses là danh sách riêng (không gộp chung toàn game).`;

const PAGE_LIB_LLM_RULES = `
Quy tắc chấm cho tiêu chí input=page_lib khi ĐÃ LIỆT KÊ ĐIỂM THƯ VIỆN ở trên: giữ đúng điểm thư viện, có thể thêm nhận xét ngắn trong reasoning/strengths nếu không mâu thuẫn.
Khi KHÔNG có điểm thư viện cho một tiêu chí page_lib:
- overview.genre: chỉ suy ra từ tag/ngữ cảnh đã cho; không bịa thể loại. Tag có thể tiếng Trung — khớp khái niệm. Không chắc thì score null hoặc ~${50} với reasoning rõ "không đủ dữ liệu".
- overview.developer: Nếu ngữ cảnh có tên Developer hoặc Publisher (snapshot DB — có thể fallback publisher=nhà vận hành): **phải** cho điểm 0–100 và reasoning; đánh giá uy tín studio/nhà phát hành dựa trên kiến thức chung + review (research có chọn lọc). **Không** để score null chỉ vì không khớp studio-tiers.json. Chỉ null khi ngữ cảnh hoàn toàn không có tên dev/publisher và review cũng không nhắc đơn vị rõ ràng.
- socialization.community_size: KHÔNG bịa fans_count từ review. Nếu không có fans_count snapshot / không khớp community-size-tiers: **bắt buộc** research (Google Trends, Steam, Discord/Reddit, forum TapTap, so sánh game tương tự) để ước lượng quy mô cộng đồng và **luôn** cho điểm 0–100; ghi nguồn suy luận; **không** để score null chỉ vì thiếu snapshot.
- overview.game_size, liveops.content_update_cycle: KHÔNG bịa số MB / ngày từ review; nếu ngữ cảnh không có số liệu snapshot thì score null.
- overview.ip_theme, overview.system_requirement, overview.art_style: ĐƯỢC suy luận có chọn lọc từ tên + tag + đoạn mô tả trong ngữ cảnh và gợn ý từ review (phong cách, IP, cấu hình); không bịa tên IP/tựa cụ thể nếu không xuất hiện trong dữ liệu; ghi rõ mức độ chắc chắn thấp nếu suy đoán.
`;

const SOCIAL_FEATURES_LLM_RULES = `
Quy tắc socialization.social_features (input=reviews):
- Chỉ đánh giá tính năng social **trong game** (guild, party, chat, co-op, leaderboard xã hội, PvP cộng đồng).
- Review **không nhắc** guild/chat/co-op **không** được coi là bằng chứng chắc chắn là game không có social → mặc định **~45–55** (trung tính), trừ khi mô tả game/tag rõ single-player/offline-only.
- Chỉ **hạ điểm dưới ~40** khi review **phàn nàn rõ** thiếu social hoặc toxic/ guild bắt buộc gây khó chịu.
- Chỉ **nâng điểm trên ~65** khi review **khen rõ** tính năng social hoặc cộng đồng trong game.
`;

function applySocialCriterionGuards(
  row: RubricCriterionOutput,
  llm: LlmRubricRow | undefined,
): void {
  if (row.id === "socialization.community_size" && row.score == null) {
    row.score = 55;
    row.reasoning =
      [row.reasoning, "Không có fans_count snapshot và LLM chưa chấm — dùng điểm trung tính 55; nên chạy lại phân tích sau khi bổ sung research."]
        .filter(Boolean)
        .join(" ")
        .trim();
    row.source = row.source === "library" ? "merged" : "llm";
  }

  if (row.id === "socialization.social_features" && row.score != null) {
    const mentions = row.mentionCount ?? llm?.mentionCount ?? 0;
    const silent = mentions <= 1;
    if (silent && row.score < 45) {
      row.score = 50;
      row.reasoning =
        [row.reasoning, "Review hầu như không nhắc social — điều chỉnh về ~50 (trung tính), không trừ nặng khi thiếu bằng chứng."]
          .filter(Boolean)
          .join(" ")
          .trim();
    }
  }
}

export function appendRubricSpec(baseSpec: string, active: RubricCriterionDef[]): string {
  const list = formatRubricCriteriaForPrompt(active);
  return `${baseSpec}\n\nDanh sách tiêu chí rubric (bắt buộc trả rubricCriteria đủ id):\n${list}\n${PAGE_LIB_LLM_RULES}\n${SOCIAL_FEATURES_LLM_RULES}\n${RED_FLAG_OUTPUT_SPEC}\n${RUBRIC_JSON_SPEC}`;
}

export function parseLlmRubricRows(analysis: Record<string, unknown>): LlmRubricRow[] {
  const raw = analysis.rubricCriteria;
  if (!Array.isArray(raw)) return [];
  const out: LlmRubricRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : "";
    if (!id) continue;
    let score: number | null = null;
    if (typeof o.score === "number") score = o.score;
    else if (o.score === null) score = null;
    out.push({
      id,
      score,
      reasoning: typeof o.reasoning === "string" ? o.reasoning : undefined,
      mentionCount: typeof o.mentionCount === "number" ? o.mentionCount : undefined,
      strengths: normalizeStringList(o.strengths),
      weaknesses: normalizeStringList(o.weaknesses),
    });
  }
  return out;
}

export function parseRedFlagSignals(analysis: Record<string, unknown>): Record<string, unknown> | null {
  const r = analysis.redFlagSignals;
  if (!r || typeof r !== "object") return null;
  return r as Record<string, unknown>;
}
