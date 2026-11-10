import { jsonrepair } from "jsonrepair";
import type { AnalysisContext } from "./analysis-context";
import { callLLM } from "../utils/ai-client";
import { compassWebSearch } from "../utils/compass-web-search";
import { aiInfoLog } from "../utils/ai-logger";

/** Tiêu chí page_lib mà prompt cũ bảo model tự "research" khi thư viện không khớp. */
const RESEARCH_NEEDS: Array<{ id: string; kpi: string; when: (ctx: AnalysisContext, scored: Set<string>) => boolean }> = [
  {
    id: "overview.developer",
    kpi: "Reputation and shipped games of the developer and publisher named in the snapshot. Include the studio's recent titles and public reputation.",
    when: (ctx, scored) => !scored.has("overview.developer") && Boolean(ctx.developerName || ctx.publisherName),
  },
  {
    id: "socialization.community_size",
    kpi: "Public community-size signals: store followers, Steam players or review counts, Discord or Reddit size, Google Trends, TapTap, and press. Include the number and the date it was published.",
    when: (_ctx, scored) => !scored.has("socialization.community_size"),
  },
  {
    id: "overview.ip_theme",
    kpi: "Whether this game is a known franchise, sequel, or licensed IP, and the original work if one is named by a source.",
    when: (_ctx, scored) => !scored.has("overview.ip_theme"),
  },
  {
    id: "overview.art_style",
    kpi: "Publicly described art direction (pixel, realistic, anime, stylized 3D, and similar).",
    when: (_ctx, scored) => !scored.has("overview.art_style"),
  },
];

export interface RubricResearchFactor {
  criterionId: string;
  finding: string;
  publishedDate: string;
  sourceUrl: string;
}

export interface RubricWebResearch {
  attempted: boolean;
  grounded: boolean;
  queries: string[];
  factors: RubricResearchFactor[];
}

const EMPTY: RubricWebResearch = { attempted: false, grounded: false, queries: [], factors: [] };

export function missingResearchNeeds(
  ctx: AnalysisContext,
  libraryCriterionIds: Iterable<string>,
): Array<{ id: string; kpi: string }> {
  const scored = new Set(libraryCriterionIds);
  return RESEARCH_NEEDS.filter((need) => need.when(ctx, scored)).map(({ id, kpi }) => ({ id, kpi }));
}

function buildQuestion(ctx: AnalysisContext, needs: Array<{ id: string; kpi: string }>): string {
  const tags = ctx.tagValues.length ? ctx.tagValues.join(", ") : "none";
  return [
    `Mobile game "${ctx.gameName}".`,
    `Developer on the store snapshot: ${ctx.developerName ?? "unknown"}.`,
    `Publisher on the store snapshot: ${ctx.publisherName ?? "unknown"}.`,
    `Store tags: ${tags}.`,
    "The scoring library has no row for the KPIs below. Search the live web and report only facts that appear in the search results.",
    ...needs.map((need, index) => `${index + 1}. ${need.id} — ${need.kpi}`),
  ].join("\n");
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  let cleaned = content.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    try {
      const parsed = JSON.parse(jsonrepair(cleaned)) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
}

function extractFactors(
  content: string,
  allowedIds: Set<string>,
  allowedUrls: Set<string>,
): RubricResearchFactor[] {
  const parsed = parseJsonObject(content);
  const rows = parsed?.factors;
  if (!Array.isArray(rows)) return [];
  const out: RubricResearchFactor[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const criterionId = typeof item.criterionId === "string" ? item.criterionId.trim() : "";
    const finding = typeof item.finding === "string" ? item.finding.trim() : "";
    const publishedDate = typeof item.publishedDate === "string" ? item.publishedDate.trim() : "";
    const sourceUrl = typeof item.sourceUrl === "string" ? item.sourceUrl.trim() : "";
    if (!allowedIds.has(criterionId) || !allowedUrls.has(sourceUrl)) continue;
    if (!finding || !/^\d{4}-\d{2}-\d{2}$/.test(publishedDate)) continue;
    const key = `${criterionId}\n${sourceUrl}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ criterionId, finding: finding.slice(0, 500), publishedDate, sourceUrl });
  }
  return out;
}

const EXTRACT_SYSTEM = `You turn a web-search brief into JSON. Return one JSON object only, no markdown:
{"factors":[{"criterionId":"...","finding":"...","publishedDate":"YYYY-MM-DD","sourceUrl":"https://..."}]}
Rules:
- finding is one Vietnamese sentence and must restate a claim already in the brief. Do not add facts.
- publishedDate is copied from that claim (YYYY-MM-DD). Omit the factor when the brief has no date.
- sourceUrl is copied exactly from the allowed URL list. Omit the factor when its URL is not in that list.
- criterionId is one of the requested ids. Omit anything else.
- If nothing qualifies, return {"factors":[]}.`;

async function structureFactors(
  brief: string,
  needs: Array<{ id: string; kpi: string }>,
  sources: string[],
): Promise<RubricResearchFactor[]> {
  const allowedIds = new Set(needs.map((need) => need.id));
  const allowedUrls = new Set(sources);
  const user = [
    "Allowed URLs (copy exactly, or omit the factor):",
    ...sources,
    "",
    "Requested criterion ids:",
    ...needs.map((need) => `- ${need.id}`),
    "",
    "Brief:",
    brief,
  ].join("\n");
  const response = await callLLM(EXTRACT_SYSTEM, user, 2_048);
  return extractFactors(response.content, allowedIds, allowedUrls).filter((factor) =>
    brief.includes(factor.publishedDate),
  );
}

export async function researchMissingRubricFacts(
  ctx: AnalysisContext,
  libraryCriterionIds: Iterable<string>,
): Promise<RubricWebResearch> {
  const needs = missingResearchNeeds(ctx, libraryCriterionIds);
  if (needs.length === 0) return EMPTY;

  try {
    const search = await compassWebSearch(buildQuestion(ctx, needs));
    aiInfoLog(
      `[AI Analysis] web research ${ctx.gameName}: grounded=${search.grounded} queries=${search.queries.length} sources=${search.sources.length} brief=${search.brief.length}`,
    );
    if (!search.grounded || !search.brief || search.sources.length === 0) {
      return { attempted: true, grounded: search.grounded, queries: search.queries, factors: [] };
    }
    const factors = await structureFactors(search.brief, needs, search.sources);
    aiInfoLog(`[AI Analysis] web research ${ctx.gameName}: kept ${factors.length} sourced factors`);
    return { attempted: true, grounded: true, queries: search.queries, factors };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    aiInfoLog(`[AI Analysis] web research ${ctx.gameName} failed: ${message.slice(0, 300)}`);
    return { attempted: true, grounded: false, queries: [], factors: [] };
  }
}

export function formatResearchForPrompt(research: RubricWebResearch): string {
  if (!research.attempted) {
    return "Web research: không gọi — các tiêu chí cần nguồn ngoài đã có điểm thư viện.";
  }
  if (!research.grounded) {
    return [
      "Web research: Compass web_search không hoàn tất (không có web_search_call status=completed với queries).",
      "KHÔNG dùng kiến thức huấn luyện để điền sự kiện, ngày, hoặc URL.",
      "overview.developer không có điểm thư viện → ~50, reasoning ghi không có nguồn web.",
      "socialization.community_size không có điểm thư viện → 55, reasoning ghi tra cứu web không có nguồn.",
      "overview.ip_theme và overview.art_style: chỉ suy từ tag/mô tả đã có trong ngữ cảnh; không bịa tên IP.",
    ].join("\n");
  }
  if (research.factors.length === 0) {
    return [
      `Web research đã search (queries: ${research.queries.join(" | ") || "(không liệt kê)"}).`,
      "Không có finding nào kèm URL nằm trong action.sources. Không bịa nguồn.",
      "overview.developer → ~50; socialization.community_size → 55; IP/art chỉ từ tag và mô tả trong ngữ cảnh.",
    ].join("\n");
  }
  const lines = research.factors.map(
    (factor) => `- ${factor.criterionId}: ${factor.finding} (${factor.publishedDate}) ${factor.sourceUrl}`,
  );
  return [
    `Web research (Compass web_search, queries: ${research.queries.join(" | ")}).`,
    "Chỉ các dòng dưới là nguồn ngoài được dùng. Không thêm URL. Không bổ sung sự kiện từ kiến thức huấn luyện.",
    ...lines,
  ].join("\n");
}
