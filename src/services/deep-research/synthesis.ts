import { callLLM } from "../../utils/ai-client";
import type { MappingDto, MarketReport, MetricScore, SteamReport, SynthesisDto, TapTapSnapshot, Verdict, WebReport } from "./types";

const VERDICTS: Verdict[] = ["strong", "promising", "watch", "weak", "insufficient"];

const SYSTEM = `Bạn là chuyên viên sourcing game mobile cho nhà phát hành ở Việt Nam. Bạn đánh giá tiềm năng thương mại của một game Trung Quốc dựa trên dữ liệu được cung cấp.
Trả về đúng một JSON object, không markdown:
{"verdict":"strong|promising|watch|weak|insufficient","headline":"...","patternRead":"...","insights":[{"text":"...","refs":["..."]}],"risks":[{"text":"...","refs":["..."]}],"opportunities":[{"text":"...","refs":["..."]}],"verify":[{"question":"...","why":"..."}],"nextStep":"..."}
Quy tắc:
- Chỉ dùng số liệu và sự kiện có trong dữ liệu. Không dùng kiến thức huấn luyện để thêm số, ngày, tên sản phẩm hay sự kiện.
- refs chỉ lấy từ danh sách "Allowed refs" (id chỉ số như st.revenue, steam.ccu, taptap.momentum hoặc id finding như F3). Mỗi insight/risk/opportunity cần ít nhất 1 ref.
- Đánh giá theo pattern genre đã cho: chỉ số có trọng số cao quan trọng hơn. Nêu rõ khi thiếu dữ liệu.
- verdict: strong = số liệu thị trường mạnh và bền; promising = tín hiệu tốt nhưng còn sớm hoặc thiếu một mảng; watch = lẫn lộn, cần theo dõi; weak = số liệu yếu hoặc suy giảm rõ; insufficient = không đủ dữ liệu để kết luận.
- headline: 1 câu kết luận. patternRead: 2–3 câu đọc game theo pattern genre (game đang khớp hay lệch mô hình điển hình ở đâu).
- insights 3–6 ý, risks 1–4, opportunities 1–4, mỗi ý 1–2 câu tiếng Việt, có số cụ thể khi có.
- verify: 1–4 câu hỏi cho người dùng xác minh những điểm dữ liệu không chắc (ví dụ số liệu CN chỉ iOS, finding mâu thuẫn). Chỉ hỏi lại mapping khi phần "Mapping" ghi là không chắc chắn.
- nextStep: 1 câu đề xuất bước tiếp theo cho team sourcing.`;

const fmt = (v: number | null, digits = 2) => (v === null ? "n/a" : Number.isInteger(v) ? String(v) : v.toFixed(digits));

function metricLines(prefix: string, metrics: MetricScore[]): string[] {
  return metrics.map(
    (m) =>
      `- ${prefix}.${m.key} ${m.label}: value=${fmt(m.value, 4)} ${m.unit}${m.percentile !== null ? ` percentile=${fmt(m.percentile, 0)}` : ""}${m.score !== null ? ` score=${fmt(m.score, 0)}` : ""} weight=${m.weight}${m.cohortMedian !== null ? ` cohortMedian=${fmt(m.cohortMedian, 4)}` : ""}`,
  );
}

export function allowedRefs(taptap: TapTapSnapshot | null, market: MarketReport | null, steam: SteamReport | null, web: WebReport | null): Set<string> {
  const refs = new Set<string>();
  if (taptap?.potential) for (const k of ["composite", "momentum", "audience", "rating", "rankQuality", "rank", "growth"]) refs.add(`taptap.${k}`);
  if (taptap) for (const k of ["fans", "reserve", "downloads", "rating"]) refs.add(`taptap.${k}`);
  for (const m of market?.metrics ?? []) refs.add(`st.${m.key}`);
  if (market?.benchmark) for (const k of ["rankRevenue", "rankDau", "share", "trend"]) refs.add(`st.${k}`);
  if (market) refs.add("st.monthly");
  for (const m of steam?.metrics ?? []) refs.add(`steam.${m.key}`);
  for (const f of web?.findings ?? []) refs.add(f.id);
  return refs;
}

const METHOD_LABEL: Record<string, string> = {
  itunes_id: "trùng App Store id (chắc chắn)",
  android_package: "trùng package Android (chắc chắn)",
  name_exact: "trùng chính xác tên (khá chắc chắn)",
  st_name_exact: "trùng tên tiếng Anh với bản Sensor Tower (khá chắc chắn)",
  web_link: "link Steam từ web search (khá chắc chắn)",
  manual: "người dùng đã xác nhận (chắc chắn)",
};

function mappingLine(label: string, side: { status: MappingDto["st"]["status"]; method: string | null; ref: { name: string } | null }): string {
  if (side.status === "none") return `${label}: không có trên ${label}`;
  if (side.status === "unmapped" || !side.ref) return `${label}: chưa ghép`;
  return `${label}: ${side.ref.name} — ${METHOD_LABEL[side.method ?? ""] ?? side.method ?? "không rõ cách ghép"}`;
}

function buildPrompt(taptap: TapTapSnapshot | null, market: MarketReport | null, steam: SteamReport | null, web: WebReport | null, refs: Set<string>, mapping: MappingDto | null): string {
  const lines: string[] = [];
  if (mapping) lines.push("## Mapping", mappingLine("Sensor Tower", mapping.st), mappingLine("Steam", mapping.steam), "");
  if (taptap) {
    const p = taptap.potential;
    lines.push(
      "## TapTap",
      `Tên: ${taptap.title}; NPH/NPT: ${taptap.developers.map((d) => d.name).join(", ") || "n/a"}; ra mắt: ${taptap.releaseDate ?? "chưa/không rõ"}; tag: ${taptap.tags.join(", ") || "n/a"}`,
      `- taptap.rating ${taptap.rating ?? "n/a"}; taptap.fans ${fmt(taptap.fans)}; taptap.reserve ${fmt(taptap.reserveCount)}; taptap.downloads ${fmt(taptap.downloadCount)}`,
    );
    if (p) {
      lines.push(
        `Potential (${p.segment}, ${p.days} ngày, ${p.platform}): taptap.composite=${fmt(p.compositeScore, 1)} taptap.momentum=${fmt(p.momentumScore, 1)} taptap.audience=${fmt(p.audienceScore, 1)} taptap.rating=${fmt(p.ratingScore, 1)} taptap.rankQuality=${fmt(p.rankQualityScore, 1)} taptap.rank=${fmt(p.currentRank)} taptap.growth=${p.audienceGrowthRate === null ? "n/a" : `${fmt(p.audienceGrowthRate * 100, 1)}%`} trend=${p.trend ?? "n/a"} (điểm 0–100)`,
      );
    }
  }
  if (market) {
    const b = market.benchmark;
    lines.push(
      "",
      "## Sensor Tower",
      `Game: ${market.name} (${market.publisher ?? "n/a"}); taxonomy: ${[market.taxonomy.class, market.taxonomy.genre, market.taxonomy.subgenre].filter(Boolean).join(" > ")}; ra mắt sớm nhất ${market.releaseDates.earliest ?? "n/a"}; CN ${market.releaseDates.cn ?? "n/a"}`,
      `Pattern: ${market.pattern.label} — ${market.pattern.summary}`,
      `Thị trường chính: ${market.primaryCountry}; Market score ${fmt(market.marketScore, 1)}/100 (độ tin cậy ${market.confidence})`,
      ...metricLines("st", market.metrics),
    );
    if (b) {
      lines.push(
        `Benchmark ${b.level} "${b.group}" ${b.country} ${b.month.slice(0, 7)}: ${b.cohortSize} game; st.rankRevenue=${fmt(b.rankRevenue)} st.rankDau=${fmt(b.rankDau)} st.share=${fmt(b.shareOfRevenue)}% doanh thu nhóm; top: ${b.top.map((t) => `${t.name} $${fmt(t.revenueUsd, 0)}`).join("; ")}`,
      );
      if (b.trend.length) lines.push(`st.trend (doanh thu nhóm theo tháng, USD): ${b.trend.map((t) => `${t.month.slice(0, 7)} ${fmt(t.revenueUsd, 0)}`).join(", ")}`);
    }
    const series = market.countries[market.primaryCountry]?.monthly ?? [];
    lines.push(`st.monthly ${market.primaryCountry} (tháng: doanh thu USD / DAU TB / lượt tải): ${series.slice(-8).map((m) => `${m.month.slice(0, 7)} ${fmt(m.revenueUsd, 0)}/${fmt(m.avgDau, 0)}/${fmt(m.downloads, 0)}`).join("; ")}`);
    lines.push(...market.notes.map((n) => `Lưu ý: ${n}`));
  } else {
    lines.push("", "## Sensor Tower", "Không có dữ liệu (chưa ghép được hoặc game không có trên Sensor Tower).");
  }
  if (steam) {
    lines.push("", "## Steam", `Game: ${steam.ref.name}; dev ${steam.ref.developers.join(", ")}; ra mắt ${steam.ref.releaseDate ?? "n/a"}; Steam score ${fmt(steam.steamScore, 1)}/100`, ...metricLines("steam", steam.metrics));
  }
  if (web?.findings.length) {
    lines.push("", "## Web findings", ...web.findings.map((f) => `- ${f.id} [${f.subject}/${f.category}/${f.sentiment}] ${f.date}: ${f.claim}`));
  } else {
    lines.push("", "## Web findings", "Không có finding nào có nguồn.");
  }
  lines.push("", `Allowed refs: ${[...refs].join(", ")}`);
  return lines.join("\n");
}

function parseJson(content: string): Record<string, unknown> {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI không trả về JSON");
  return JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>;
}

const s = (v: unknown, max = 600) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function items(v: unknown, refs: Set<string>, max: number): Array<{ text: string; refs: string[] }> {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : null))
    .filter((x): x is Record<string, unknown> => x !== null && Boolean(s(x.text)))
    .map((x) => ({ text: s(x.text), refs: (Array.isArray(x.refs) ? x.refs : []).filter((r): r is string => typeof r === "string" && refs.has(r)) }))
    .slice(0, max);
}

export async function synthesize(
  taptap: TapTapSnapshot | null,
  market: MarketReport | null,
  steam: SteamReport | null,
  web: WebReport | null,
  mapping: MappingDto | null = null,
): Promise<SynthesisDto> {
  const refs = allowedRefs(taptap, market, steam, web);
  const response = await callLLM(SYSTEM, buildPrompt(taptap, market, steam, web, refs, mapping), 8000);
  const j = parseJson(response.content);
  const verdict = VERDICTS.includes(j.verdict as Verdict) ? (j.verdict as Verdict) : "insufficient";
  return {
    verdict,
    headline: s(j.headline, 300),
    patternRead: s(j.patternRead, 900),
    insights: items(j.insights, refs, 6),
    risks: items(j.risks, refs, 4),
    opportunities: items(j.opportunities, refs, 4),
    verify: (Array.isArray(j.verify) ? j.verify : [])
      .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : {}))
      .filter((x) => s(x.question))
      .map((x) => ({ question: s(x.question, 300), why: s(x.why, 300) }))
      .slice(0, 4),
    nextStep: s(j.nextStep, 400),
    model: response.model,
  };
}
