import { callLLM, getModel } from "../utils/ai-client";
import { pool } from "../utils/prisma";
import { prisma } from "../utils/prisma";
import type { AIAnalysisResult, AIFeedbackItem, SentimentBreakdown, SentimentCriterion, TapTapRawApp } from "../types";
import fs from "fs";
import path from "path";

const STORE_FILE = path.join(process.cwd(), ".ai-analysis-store.json");

function loadStore(): Record<string, AIAnalysisResult[]> {
  try {
    if (fs.existsSync(STORE_FILE)) {
      return JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
    }
  } catch { /* ignore corrupt file */ }
  return {};
}

function saveStore(store: Record<string, AIAnalysisResult[]>) {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(store), "utf-8");
  } catch (err) {
    console.error("[ai-store] Failed to save:", err);
  }
}

const RATING_BUCKETS = [
  { label: "Very Negative", min: 1, max: 1 },
  { label: "Negative", min: 2, max: 2 },
  { label: "Mixed", min: 3, max: 3 },
  { label: "Positive", min: 4, max: 4 },
  { label: "Very Positive", min: 5, max: 5 },
] as const;

const PER_BUCKET_LIMIT = 100_000;

function intEnv(name: string, def: number): number {
  const v = process.env[name];
  if (v == null || v === "") return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

/** Truncate + normalize per review before sending to the LLM. Collection logic is unchanged. */
const AI_REVIEW_MAX_CHARS = (() => {
  const m = intEnv("AI_REVIEW_MAX_CHARS", 2_000);
  return m <= 0 ? Number.POSITIVE_INFINITY : m;
})();

/** If the (compressed) one-shot prompt is longer, use map-reduce. Tune down if 400s on small context models. */
const AI_SINGLE_PROMPT_MAX_CHARS = intEnv("AI_SINGLE_PROMPT_MAX_CHARS", 500_000);
/** Max characters of review text block per map batch (larger = fewer map rounds, faster with concurrency). */
const AI_MAP_CHUNK_MAX_CHARS = intEnv("AI_MAP_CHUNK_MAX_CHARS", 300_000);
/** Parallel map() LLM calls per wave. Lower (e.g. 2) if you hit 429 from the provider. */
const AI_MAP_CONCURRENCY = Math.max(1, intEnv("AI_MAP_CONCURRENCY", 6));
/** After packing, merge down to at most this many map batches (default 3). */
const AI_MAX_MAP_CHUNKS = Math.max(1, intEnv("AI_MAX_MAP_CHUNKS", 3));

function collapseWhitespace(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function clipReviewTextForLLM(text: string): string {
  const t = collapseWhitespace(text);
  if (t.length <= AI_REVIEW_MAX_CHARS) return t;
  return `${t.slice(0, Math.max(0, Math.floor(AI_REVIEW_MAX_CHARS) - 1))}…`;
}

function withClippedText(r: StratifiedReview): StratifiedReview {
  return { ...r, text: clipReviewTextForLLM(r.text) };
}

function lineForReview(global1Based: number, r: StratifiedReview): string {
  return `[#${global1Based}|${r.score}★|${r.date}]\n${r.text}`;
}

const SYSTEM_MAP = `Bạn đang trích xuất tín hiệu từ MỘT lô đánh giá người chơi về game mobile (nhiều ngôn ngữ). Chỉ trả lời bằng TIẾNG VIỆT. Chỉ trả về MỘT object JSON hợp lệ, không markdown, không text ngoài JSON. Schema:
{
  "strengths": [{"point":"...","roughCount":<số review trong lô này ủng hộ ý này, số nguyên>}],
  "weaknesses": [{"point":"...","roughCount":<số nguyên>}],
  "topicHints": {"gameplay":0-100,"graphics":0-100,"story":0-100,"monetization":0-100,"performance":0-100,"community":0-100},
  "subsetSummary":"2-3 câu tiếng Việt: cảm xúc và vấn đề chính CHỈ trong lô này"
}
roughCount chỉ cho lô này, không phải toàn game.`;

const SYSTEM_REDUCE = `Bạn là chuyên gia phân tích game mobile. Bạn nhận kết quả trích xuất từ TẤT CẢ các lô đánh giá của cùng một game; các lô không trùng nhau và cùng phủ toàn bộ review đã thu thập. Bạn cũng có số lượng review theo từng mức sao. Hãy tổng hợp một bức tranh thống nhất. Nếu các lô mâu thuẫn, hãy suy luận theo toàn dữ liệu. BẮT BUỘC chỉ trả về MỘT object JSON hợp lệ, không markdown, không text ngoài JSON, đúng schema người dùng cung cấp. Mọi văn bản trong JSON phải bằng TIẾNG VIỆT.`;

const SYSTEM_PROMPT = `Bạn là chuyên gia phân tích thị trường game mobile.
Bạn nhận đánh giá người chơi (TapTap hoặc nguồn khác), phân tầng theo sao 1-5.
Review có thể tiếng Trung, Anh, Việt hoặc hỗn hợp. Phân tích kỹ và trả lời toàn bộ bằng TIẾNG VIỆT.
BẮT BUỘC chỉ trả về MỘT object JSON hợp lệ. Không markdown, không giải thích ngoài JSON.`;

export interface StratifiedReview {
  text: string;
  score: number;
  date: string;
  bucket: string;
}

function parseReviewRow(
  row: { raw: Record<string, unknown>; reviewAt: Date | null },
  bucketLabel: string,
): StratifiedReview | null {
  const raw = row.raw;
  const review = raw?.review as Record<string, unknown> | undefined;
  const contents = review?.contents as Record<string, unknown> | undefined;
  const text =
    (contents?.text as string) ??
    ((raw?.sharing as Record<string, unknown>)?.description as string) ??
    "";
  if (text.length < 5) return null;

  const score = (review?.score as number) ?? 0;
  const date = row.reviewAt
    ? row.reviewAt.toISOString().slice(0, 10)
    : "unknown";

  return { text, score, date, bucket: bucketLabel };
}

async function fetchStratifiedReviews(appId: number): Promise<StratifiedReview[]> {
  const startMs = Date.now();

  const { rows } = await pool.query<{ raw: Record<string, unknown>; reviewAt: Date | null }>(
    `SELECT raw, "reviewAt"
     FROM "AppReview"
     WHERE "appId" = $1
       AND raw IS NOT NULL
     ORDER BY "reviewAt" DESC`,
    [appId]
  );

  console.log(`[AI Analysis] Fetched ${rows.length} raw reviews in ${Date.now() - startMs}ms`);

  const allReviews: StratifiedReview[] = [];

  for (const row of rows) {
    const raw = row.raw;
    const review = raw?.review as Record<string, unknown> | undefined;
    const score = Math.round(Number(review?.score ?? 0));
    const bucket = RATING_BUCKETS.find((b) => score >= b.min && score <= b.max);
    const bucketLabel = bucket?.label ?? "Unrated";
    const r = parseReviewRow(row, bucketLabel);
    if (r) allReviews.push(r);
  }

  console.log(`[AI Analysis] Parsed ${allReviews.length} valid reviews in ${Date.now() - startMs}ms`);

  return allReviews;
}

function buildBucketCounts(reviews: StratifiedReview[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const b of RATING_BUCKETS) counts[b.label] = 0;
  for (const r of reviews) counts[r.bucket] = (counts[r.bucket] ?? 0) + 1;
  return counts;
}

function getDateRange(reviews: StratifiedReview[]): { start: string | null; end: string | null } {
  const dates = reviews.map((r) => r.date).filter((d) => d !== "unknown").sort();
  return { start: dates[0] ?? null, end: dates[dates.length - 1] ?? null };
}

function buildReviewTextBlock(
  reviews: StratifiedReview[],
  firstIndex1Based: number,
): string {
  const start = firstIndex1Based;
  return reviews
    .map((r, i) => lineForReview(start + i, r))
    .join("\n\n");
}

const FINAL_OUTPUT_SPEC = `Trả về một object JSON đúng cấu trúc sau (toàn bộ chuỗi tiếng Việt):
{
  "summaryBullets": ["Gạch đầu dòng 1: ý chính về cảm xúc tổng thể", "Gạch đầu dòng 2: ...", "..."],
  "strengths": [
    {"point": "mô tả điểm mạnh bằng tiếng Việt", "mentionRate": <số nguyên 0-100, % review nhắc tới>}
  ],
  "weaknesses": [
    {"point": "mô tả điểm yếu bằng tiếng Việt", "mentionRate": <số nguyên 0-100>}
  ],
  "sentimentScore": <số nguyên 0-100>,
  "sentimentBreakdown": {
    "ratingDistribution": {
      "score": <0-100, trung bình có trọng số theo sao: 1★=0, 2★=25, 3★=50, 4★=75, 5★=100>,
      "reasoning": "1-2 câu tiếng Việt"
    },
    "textSentiment": {
      "score": <0-100, cảm xúc thực tế trong lời văn review>,
      "reasoning": "1-2 câu tiếng Việt"
    },
    "issueSeverity": {
      "score": <0-100, cao = vấn đề ít nghiêm trọng>,
      "reasoning": "1-2 câu tiếng Việt"
    },
    "trendMomentum": {
      "score": <0-100, review gần đây tích cực hơn hay tiêu cực hơn quá khứ>,
      "reasoning": "1-2 câu tiếng Việt"
    },
    "formula": "Một câu tiếng Việt: Điểm cuối X = (ratingDistribution×30% + textSentiment×35% + issueSeverity×20% + trendMomentum×15%)"
  },
  "recentTrendBullets": ["Gạch đầu dòng 1: xu hướng theo thời gian", "Gạch đầu dòng 2: ...", "..."],
  "topics": {
    "gameplay": <0-100>,
    "graphics": <0-100>,
    "story": <0-100>,
    "monetization": <0-100>,
    "performance": <0-100>,
    "community": <0-100>
  }
}

Quy tắc:
- summaryBullets: 4–10 dòng, mỗi phần tử là MỘT gạch đầu dòng ngắn gọn (KHÔNG gộp thành đoạn văn dài một chuỗi).
- recentTrendBullets: 3–8 dòng, theo mốc thời gian / bản cập nhật nếu có trong dữ liệu.
- sentimentScore PHẢI bằng làm tròn: ratingDistribution×0.30 + textSentiment×0.35 + issueSeverity×0.20 + trendMomentum×0.15.
- strengths/weaknesses: chỉ điểm thực sự có trong review; mentionRate là % ước lượng trên TOÀN BỘ review đã phân tích; sắp xếp mentionRate giảm dần.
- Cụ thể, hành động được (ví dụ "hệ chiến đấu combo hấp dẫn" thay vì "gameplay hay").`;

function buildAnalysisPrompt(gameName: string, reviews: StratifiedReview[]): string {
  const reviewBlock = buildReviewTextBlock(reviews, 1);

  return `Phân tích ${reviews.length} đánh giá người chơi cho game mobile "${gameName}".
Dữ liệu đã phân tầng theo sao 1-5 để cân bằng ý kiến tích cực và tiêu cực.
Mỗi dòng có dạng [#chỉ mục|số sao|ngày] rồi đến nội dung review.

Reviews:
${reviewBlock}

${FINAL_OUTPUT_SPEC}`;
}

function lineCharLen(r: StratifiedReview, global1Based: number): number {
  return lineForReview(global1Based, r).length;
}

type ReviewChunk = { firstIndex1Based: number; reviews: StratifiedReview[] };

function packReviewsIntoMapChunks(
  reviews: StratifiedReview[],
  maxBlockChars: number,
): ReviewChunk[] {
  const chunks: ReviewChunk[] = [];
  let current: StratifiedReview[] = [];
  let used = 0;
  let firstG = 1;
  let g = 0;

  for (const r of reviews) {
    g += 1;
    const sep = current.length > 0 ? 2 : 0;
    let row: StratifiedReview = r;
    if (sep + lineCharLen(row, g) > maxBlockChars) {
      const budget = Math.max(40, maxBlockChars - sep - 40);
      row = { ...r, text: `${r.text.slice(0, Math.max(0, budget - 1))}…` };
    }
    const add = sep + lineCharLen(row, g);
    if (current.length > 0 && used + add > maxBlockChars) {
      chunks.push({ firstIndex1Based: firstG, reviews: current });
      current = [];
      used = 0;
      firstG = g;
    }
    current.push(row);
    used += add;
  }

  if (current.length > 0) {
    chunks.push({ firstIndex1Based: firstG, reviews: current });
  }
  return chunks;
}

function mergeMapChunksToMax(chunks: ReviewChunk[], max: number): ReviewChunk[] {
  if (chunks.length <= max) return chunks;
  const groupSize = Math.ceil(chunks.length / max);
  const out: ReviewChunk[] = [];
  for (let i = 0; i < chunks.length; i += groupSize) {
    const group = chunks.slice(i, i + groupSize);
    const reviews = group.flatMap((c) => c.reviews);
    out.push({ firstIndex1Based: group[0]!.firstIndex1Based, reviews });
  }
  return out;
}

function buildMapUserPrompt(
  gameName: string,
  batch: number,
  totalBatches: number,
  reviewBlock: string,
): string {
  return `Game: "${gameName}" — lô trích xuất ${batch}/${totalBatches} (một phần rời của toàn bộ review). Định dạng: [#n|sao|ngày] rồi nội dung.
${reviewBlock}`;
}

function buildReduceUserPrompt(
  gameName: string,
  totalReviews: number,
  bucketCounts: Record<string, number>,
  dateRange: { start: string | null; end: string | null },
  mapRawJsonStrings: string[],
): string {
  return `Tổng hợp MỘT bản phân tích cho game "${gameName}" từ ${mapRawJsonStrings.length} lô trích xuất rời nhau, cùng phủ toàn bộ ${totalReviews} review đã thu thập (không bỏ sót; thứ tự lô không nhất thiết theo thời gian).

Số liệu tham chiếu:
- số review: ${totalReviews}
- số theo bucket: ${JSON.stringify(bucketCounts)}
- khoảng ngày: ${dateRange.start ?? "unknown"} .. ${dateRange.end ?? "unknown"}
- mentionRate trong JSON cuối phải ước lượng theo % trên TOÀN BỘ ${totalReviews} review (không dùng trực tiếp roughCount của từng lô làm % cuối).

Dữ liệu từng lô (JSON, mỗi lô một khối):
${mapRawJsonStrings.map((s, i) => `--- lô ${i + 1} ---\n${s}`).join("\n\n")}

${FINAL_OUTPUT_SPEC}`;
}

function normalizeBulletArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => String(x).trim()).filter((s) => s.length > 0);
}

function bulletsFromLegacyParagraph(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  const byNewline = t
    .split(/\n+/)
    .map((l) => l.replace(/^[-•*·]\s*/, "").trim())
    .filter(Boolean);
  if (byNewline.length > 1) return byNewline;
  const sentences = t
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return sentences.length > 0 ? sentences : [t];
}

function assignTier(rate: number): "frequent" | "moderate" | "rare" {
  if (rate >= 30) return "frequent";
  if (rate >= 10) return "moderate";
  return "rare";
}

function parseFeedbackItems(raw: unknown): AIFeedbackItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item: unknown) => {
    if (typeof item === "string") {
      return { point: item, mentionRate: 0, tier: "rare" as const };
    }
    const obj = item as Record<string, unknown>;
    const rate = typeof obj.mentionRate === "number" ? obj.mentionRate : 0;
    return {
      point: String(obj.point ?? obj.description ?? ""),
      mentionRate: rate,
      tier: assignTier(rate),
    };
  }).filter((i) => i.point.length > 0)
    .sort((a, b) => b.mentionRate - a.mentionRate);
}

function parseCriterion(raw: unknown): SentimentCriterion {
  const obj = (raw ?? {}) as Record<string, unknown>;
  return {
    score: typeof obj.score === "number" ? obj.score : 50,
    reasoning: typeof obj.reasoning === "string" ? obj.reasoning : "",
  };
}

function parseSentimentBreakdown(raw: unknown): SentimentBreakdown | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  return {
    ratingDistribution: parseCriterion(obj.ratingDistribution),
    textSentiment: parseCriterion(obj.textSentiment),
    issueSeverity: parseCriterion(obj.issueSeverity),
    trendMomentum: parseCriterion(obj.trendMomentum),
    formula: typeof obj.formula === "string" ? obj.formula : "",
  };
}

export class AIAnalysisService {
  getAllAnalyses(): AIAnalysisResult[] {
    const store = loadStore();
    const all: AIAnalysisResult[] = [];
    for (const list of Object.values(store)) {
      for (const item of list) all.push(item);
    }
    all.sort((a, b) => (b.analyzedAt ?? "").localeCompare(a.analyzedAt ?? ""));
    return all;
  }

  getLatestAnalysis(appId: number): AIAnalysisResult | null {
    const store = loadStore();
    const history = store[String(appId)];
    if (!history || history.length === 0) return null;
    return history[history.length - 1];
  }

  getAnalysisHistory(appId: number): AIAnalysisResult[] {
    const store = loadStore();
    return (store[String(appId)] ?? []).slice().reverse();
  }

  deleteAnalysis(appId: number, analyzedAt: string): boolean {
    const store = loadStore();
    const key = String(appId);
    const list = store[key];
    if (!list) return false;
    const before = list.length;
    store[key] = list.filter((a) => a.analyzedAt !== analyzedAt);
    if (store[key].length === before) return false;
    if (store[key].length === 0) delete store[key];
    saveStore(store);
    return true;
  }

  deleteAllAnalyses(appId: number): number {
    const store = loadStore();
    const key = String(appId);
    const count = store[key]?.length ?? 0;
    if (count === 0) return 0;
    delete store[key];
    saveStore(store);
    return count;
  }

  private async runLLMAnalysis(
    appId: number,
    gameName: string,
    reviews: StratifiedReview[],
    opts?: { source?: "database" | "external" | "csv-upload"; iconUrl?: string | null },
  ): Promise<AIAnalysisResult> {
    const bucketCounts = buildBucketCounts(reviews);
    const dateRange = getDateRange(reviews);
    const prepared: StratifiedReview[] = reviews.map((r) => withClippedText(r));

    const model = getModel();
    const oneShot = buildAnalysisPrompt(gameName, prepared);
    const estTokens = (s: string) => Math.ceil(s.length / 3);

    let content: string;

    if (oneShot.length <= AI_SINGLE_PROMPT_MAX_CHARS) {
      console.log(
        `[AI Analysis] ${gameName}: single call, ${reviews.length} reviews, model=${model}, ` +
        `~${estTokens(oneShot)} prompt tok (cap reviews=${Number.isFinite(AI_REVIEW_MAX_CHARS) ? AI_REVIEW_MAX_CHARS : "unlimited"})`
      );
      try {
        const response = await callLLM(SYSTEM_PROMPT, oneShot, 16_384);
        content = response.content;
        console.log(
          `[AI Analysis] ${gameName}: LLM done (${response.inputTokens ?? "?"}in/${response.outputTokens ?? "?"}out tok)`
        );
      } catch (llmErr: unknown) {
        const status = (llmErr as { status?: number }).status;
        const body = (llmErr as { error?: unknown }).error;
        console.error(`[AI Analysis] LLM error (status ${status}):`, JSON.stringify(body ?? llmErr));
        throw new Error(`LLM request failed (${status ?? "unknown"})`);
      }
    } else {
      const packed = packReviewsIntoMapChunks(prepared, AI_MAP_CHUNK_MAX_CHARS);
      const mapChunks = mergeMapChunksToMax(packed, AI_MAX_MAP_CHUNKS);
      if (packed.length !== mapChunks.length) {
        console.log(
          `[AI Analysis] ${gameName}: merged map batches ${packed.length} → ${mapChunks.length} (max ${AI_MAX_MAP_CHUNKS})`,
        );
      }
      const mapOut: string[] = new Array(mapChunks.length);
      const conc = Math.min(AI_MAP_CONCURRENCY, mapChunks.length);
      const totalBatches = mapChunks.length;
      console.log(
        `[AI Analysis] ${gameName}: map-reduce, ${reviews.length} reviews, ${totalBatches} map batches, ` +
        `concurrency=${conc}, model=${model} (single ~${estTokens(oneShot)} chars, threshold ${AI_SINGLE_PROMPT_MAX_CHARS})`
      );

      const runMapBatch = async (c: (typeof mapChunks)[0], batchIndex1: number): Promise<string> => {
        const block = buildReviewTextBlock(c.reviews, c.firstIndex1Based);
        const u = buildMapUserPrompt(gameName, batchIndex1, totalBatches, block);
        const est = estTokens(SYSTEM_MAP + u);
        console.log(
          `[AI Analysis] ${gameName}: map ${batchIndex1}/${totalBatches} (reviews ${c.reviews.length}, ~${est} tok) start`
        );
        const response = await callLLM(SYSTEM_MAP, u, 4_096);
        console.log(
          `[AI Analysis] ${gameName}: map ${batchIndex1} ok (${response.inputTokens ?? "?"}in/${response.outputTokens ?? "?"}out tok)`
        );
        return response.content.trim();
      };

      for (let w = 0; w < mapChunks.length; w += conc) {
        const end = Math.min(w + conc, mapChunks.length);
        try {
          const slice = mapChunks.slice(w, end);
          const wave = await Promise.all(
            slice.map((chunk, offset) => runMapBatch(chunk, w + offset + 1)),
          );
          for (let k = 0; k < wave.length; k++) mapOut[w + k] = wave[k]!;
        } catch (llmErr: unknown) {
          const status = (llmErr as { status?: number }).status;
          const body = (llmErr as { error?: unknown }).error;
          console.error(`[AI Analysis] LLM error (map wave ${w}..${end - 1}, status ${status}):`, JSON.stringify(body ?? llmErr));
          throw new Error(`LLM request failed (${status ?? "unknown"})`);
        }
      }
      const reducePrompt = buildReduceUserPrompt(
        gameName,
        reviews.length,
        bucketCounts,
        dateRange,
        mapOut,
      );
      try {
        const response = await callLLM(SYSTEM_REDUCE, reducePrompt, 16_384);
        content = response.content;
        console.log(
          `[AI Analysis] ${gameName}: reduce done (${response.inputTokens ?? "?"}in/${response.outputTokens ?? "?"}out tok)`
        );
      } catch (llmErr: unknown) {
        const status = (llmErr as { status?: number }).status;
        const body = (llmErr as { error?: unknown }).error;
        console.error(`[AI Analysis] LLM error (reduce, status ${status}):`, JSON.stringify(body ?? llmErr));
        throw new Error(`LLM request failed (${status ?? "unknown"})`);
      }
    }

    let cleaned = content.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    }

    const analysis = JSON.parse(cleaned);

    const breakdown = parseSentimentBreakdown(analysis.sentimentBreakdown);

    let summaryBullets = normalizeBulletArray(analysis.summaryBullets);
    if (summaryBullets.length === 0 && typeof analysis.summary === "string" && analysis.summary.trim()) {
      summaryBullets = bulletsFromLegacyParagraph(analysis.summary);
    }
    if (summaryBullets.length === 0) {
      summaryBullets = ["Không có tóm tắt."];
    }

    let recentTrendBullets = normalizeBulletArray(analysis.recentTrendBullets);
    if (recentTrendBullets.length === 0 && typeof analysis.recentTrend === "string" && analysis.recentTrend.trim()) {
      recentTrendBullets = bulletsFromLegacyParagraph(analysis.recentTrend);
    }

    const summary = summaryBullets.join("\n");
    const recentTrend = recentTrendBullets.length > 0 ? recentTrendBullets.join("\n") : "";

    const result: AIAnalysisResult = {
      appId,
      gameName,
      iconUrl: opts?.iconUrl ?? null,
      source: opts?.source ?? "database",
      summary,
      summaryBullets,
      strengths: parseFeedbackItems(analysis.strengths),
      weaknesses: parseFeedbackItems(analysis.weaknesses),
      sentimentScore: typeof analysis.sentimentScore === "number" ? analysis.sentimentScore : 50,
      sentimentBreakdown: breakdown ?? undefined,
      topics: analysis.topics ?? {},
      recentTrend,
      recentTrendBullets: recentTrendBullets.length > 0 ? recentTrendBullets : undefined,
      reviewsAnalyzed: reviews.length,
      bucketCounts,
      dateRangeStart: dateRange.start,
      dateRangeEnd: dateRange.end,
      analyzedAt: new Date().toISOString(),
    };

    const store = loadStore();
    const key = String(appId);
    if (!store[key]) store[key] = [];
    store[key].push(result);
    saveStore(store);

    console.log(`[AI Analysis] ${gameName}: saved to store (${store[key].length} total analyses)`);

    return result;
  }

  async analyzeGameReviews(appId: number): Promise<AIAnalysisResult> {
    const latestRank = await prisma.appRank.findFirst({
      where: { appId },
      orderBy: { date: "desc" },
    });

    const gameName =
      (latestRank?.raw as TapTapRawApp | null)?.title ?? `App #${appId}`;
    const iconUrl =
      (latestRank?.raw as TapTapRawApp | null)?.icon?.url ?? null;

    const reviews = await fetchStratifiedReviews(appId);

    if (reviews.length === 0) {
      throw new Error(`No reviews found for ${gameName} (appId: ${appId})`);
    }

    return this.runLLMAnalysis(appId, gameName, reviews, { source: "database", iconUrl });
  }

  async analyzeExternalReviews(
    appId: number,
    gameName: string,
    iconUrl: string | null,
    reviews: StratifiedReview[],
    source: "external" | "csv-upload" = "external",
  ): Promise<AIAnalysisResult> {
    if (reviews.length === 0) {
      throw new Error(`No reviews found for ${gameName} (appId: ${appId})`);
    }

    return this.runLLMAnalysis(appId, gameName, reviews, { source, iconUrl });
  }
}

export const aiAnalysisService = new AIAnalysisService();
