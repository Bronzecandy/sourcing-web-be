import type { AnalysisContext } from "./analysis-context";
import { loadRubricManifest, type RubricManifest } from "./rubric-manifest";
import { callLLM } from "../utils/ai-client";
import type { GenrePackPlan, GenrePackResolvedItem } from "../types";

export const GENRE_PACK_LABELS: Record<string, { vi: string; en: string }> = {
  base: { vi: "Chung (base)", en: "Base" },
  cardRpg: { vi: "Card RPG", en: "Card RPG" },
  extraction: { vi: "Extraction (Loot & Scoot)", en: "Extraction (Loot & Scoot)" },
  shooter: { vi: "Shooter", en: "Shooter" },
  moba: { vi: "MOBA", en: "MOBA" },
};

export const ALL_GENRE_PACK_IDS = ["base", "cardRpg", "extraction", "shooter", "moba"] as const;

const SYSTEM_PROMPT =
  "You are a mobile game genre analyst for rubric scoring. Respond with ONLY valid JSON, no markdown.";

export function getDistinctGenrePackIds(manifest: RubricManifest): string[] {
  const ids = new Set<string>(ALL_GENRE_PACK_IDS);
  for (const c of manifest.criteria) {
    if (c.genrePack) ids.add(c.genrePack);
  }
  if (manifest.genrePackDefault) ids.add(manifest.genrePackDefault);
  return Array.from(ids);
}

function attachLabels(packs: GenrePackResolvedItem[]): GenrePackResolvedItem[] {
  return packs.map((p) => ({
    ...p,
    labelVi: p.labelVi ?? GENRE_PACK_LABELS[p.packId]?.vi ?? p.packId,
  }));
}

/** Loại base khi có pack thể loại khác; chuẩn hóa weight tổng = 1. */
export function normalizeGenrePackPlan(plan: GenrePackPlan, manifest?: RubricManifest): GenrePackPlan {
  const valid = new Set(getDistinctGenrePackIds(manifest ?? loadRubricManifest()));
  let packs = plan.packs
    .filter((p) => p.packId && valid.has(p.packId) && p.weight > 0)
    .map((p) => ({ ...p, weight: p.weight }));

  const nonBase = packs.filter((p) => p.packId !== "base");
  if (nonBase.length > 0) {
    packs = nonBase;
  } else if (packs.length === 0) {
    packs = [{ packId: "base", weight: 1 }];
  }

  const sum = packs.reduce((s, p) => s + p.weight, 0);
  if (sum > 0 && Math.abs(sum - 1) > 0.001) {
    packs = packs.map((p) => ({ ...p, weight: p.weight / sum }));
  }

  return {
    ...plan,
    packs: attachLabels(packs),
  };
}

function equalWeightPlan(packIds: string[], reasoning: string): GenrePackPlan {
  const n = packIds.length;
  const w = 1 / n;
  return normalizeGenrePackPlan({
    packs: packIds.map((packId) => ({ packId, weight: w })),
    reasoning,
    ratioPreset: null,
  });
}

function parseLlmPackJson(content: string): {
  packs?: Array<{ packId?: string; weightPercent?: number; weight?: number }>;
  reasoning?: string;
  ratioPreset?: string | null;
} | null {
  const trimmed = content.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]) as ReturnType<typeof parseLlmPackJson>;
  } catch {
    return null;
  }
}

function buildPackInferencePrompt(ctx: AnalysisContext, packIds: string[]): string {
  const packDesc = packIds
    .map((id) => `- ${id}: ${GENRE_PACK_LABELS[id]?.en ?? id}`)
    .join("\n");
  const ratioRule =
    packIds.length === 2
      ? `Exactly 2 packs: choose ONE ratio preset — either 70:30 (dominant:secondary) or 60:40. Set "ratioPreset" to "7:3" or "6:4". Weights must match (70/30 or 60/40).`
      : `More than 2 packs: assign integer weightPercent per pack summing to 100. Set ratioPreset to null.`;

  return `Game: ${ctx.gameName}
Tags: ${ctx.tagValues.join(", ") || "(none)"}
Context: ${(ctx.searchHaystack ?? "").slice(0, 1200)}

Genre rubric packs to weight (core gameplay loop focus):
${packDesc}

${ratioRule}

Explain which gameplay elements dominate (e.g. extraction loop vs gunplay).

Output JSON only:
{
  "packs": [{"packId": "extraction", "weightPercent": 70}, {"packId": "shooter", "weightPercent": 30}],
  "reasoning": "brief Vietnamese explanation",
  "ratioPreset": "7:3" | "6:4" | null
}`;
}

export async function inferGenrePackPlanWithAI(
  ctx: AnalysisContext,
  candidatePackIds: string[],
  overridePackIds?: string[],
): Promise<GenrePackPlan> {
  const manifest = loadRubricManifest();
  const valid = new Set(getDistinctGenrePackIds(manifest));

  let targetIds = (overridePackIds?.length ? overridePackIds : candidatePackIds).filter(
    (id) => valid.has(id) && id !== "base",
  );

  if (targetIds.length === 0) {
    const onlyBase = overridePackIds?.includes("base") || candidatePackIds.length === 0;
    if (onlyBase || overridePackIds?.length === 1 && overridePackIds[0] === "base") {
      return normalizeGenrePackPlan({
        packs: [{ packId: "base", weight: 1 }],
        reasoning: "Gói base — không có thể loại riêng.",
        ratioPreset: null,
      });
    }
    return normalizeGenrePackPlan({
      packs: [{ packId: "base", weight: 1 }],
      reasoning: "Không khớp thể loại từ tag — dùng gói base.",
      ratioPreset: null,
    });
  }

  if (targetIds.length === 1) {
    return normalizeGenrePackPlan({
      packs: [{ packId: targetIds[0], weight: 1 }],
      reasoning: `Một gói thể loại: ${GENRE_PACK_LABELS[targetIds[0]]?.vi ?? targetIds[0]}.`,
      ratioPreset: null,
    });
  }

  try {
    const response = await callLLM(SYSTEM_PROMPT, buildPackInferencePrompt(ctx, targetIds), 512);
    const parsed = parseLlmPackJson(response.content);
    if (parsed?.packs?.length) {
      const allowed = new Set(targetIds);
      const rawPacks = parsed.packs
        .filter((p) => p.packId && allowed.has(p.packId))
        .map((p) => {
          const pct = p.weightPercent ?? (p.weight != null && p.weight <= 1 ? p.weight * 100 : p.weight);
          return {
            packId: String(p.packId),
            weight: Number(pct) > 0 ? Number(pct) / 100 : 0,
          };
        })
        .filter((p) => p.weight > 0);

      if (rawPacks.length >= 1) {
        const ratioPreset =
          parsed.ratioPreset === "7:3" || parsed.ratioPreset === "6:4" ? parsed.ratioPreset : null;
        return normalizeGenrePackPlan({
          packs: rawPacks,
          reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "AI phân bổ trọng số thể loại.",
          ratioPreset,
        });
      }
    }
  } catch (err) {
    console.warn("[genre-pack-inference] LLM failed, using equal weights:", (err as Error).message);
  }

  return equalWeightPlan(targetIds, "Phân bổ đều giữa các gói thể loại (fallback).");
}

export function genrePackPlanFromBody(raw: unknown, manifest?: RubricManifest): GenrePackPlan | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const packs: GenrePackResolvedItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const packId = String((item as { packId?: string }).packId ?? "").trim();
    if (!packId) continue;
    let weight = Number((item as { weight?: number }).weight);
    if (!Number.isFinite(weight) || weight <= 0) {
      const pct = Number((item as { weightPercent?: number }).weightPercent);
      weight = Number.isFinite(pct) && pct > 0 ? pct / 100 : 0;
    }
    if (weight <= 0) continue;
    packs.push({ packId, weight });
  }
  if (packs.length === 0) return null;
  return normalizeGenrePackPlan({ packs, reasoning: "", ratioPreset: null }, manifest);
}

export function primaryPackId(plan: GenrePackPlan): string {
  const nonBase = plan.packs.filter((p) => p.packId !== "base");
  if (nonBase.length === 0) return "base";
  return [...nonBase].sort((a, b) => b.weight - a.weight)[0].packId;
}
