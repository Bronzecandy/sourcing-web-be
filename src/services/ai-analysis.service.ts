import { callLLM, getModel } from "../utils/ai-client";
import { pool } from "../utils/prisma";
import { prisma } from "../utils/prisma";
import type { AIAnalysisResult, TapTapRawApp } from "../types";
import type { AnalysisProgressReporter } from "../types/analysis-progress";
import {
  createProgressStepReporter,
  runWithLlmHeartbeat,
} from "../utils/analysis-progress-reporter";
import type { ReviewWindow } from "../types/review-window";
import {
  filterReviewsByWindow,
  reviewWindowMeta,
  reviewWindowSqlBounds,
} from "../utils/review-window";
import { buildAnalysisContextFromRaw, type AnalysisContext } from "./analysis-context";
import { getActiveCriteria, loadRubricManifest } from "./rubric-manifest";
import {
  appendRubricSpec,
  formatContextForPrompt,
  formatLibraryScoresForPrompt,
  mergeRubricFromLlm,
  parseLlmRubricRows,
  parseRedFlagSignals,
  resolveLibraryScores,
  inferGenrePack,
  buildLibraryRequests,
  persistLibraryRequests,
  buildRedFlagAtAGlance,
  buildRedFlagsChecklist,
} from "./rubric-merge";
import { jsonrepair } from "jsonrepair";
import {
  deleteAllAnalysesForUser,
  deleteAnalysisForUser,
  getAnalysisHistoryForUser,
  getLatestAnalysisForUser,
  listAnalysesForUser,
  saveAnalysisForUser,
} from "./ai-analysis-store";
import { isRetryableDbError, withDbRetry } from "../utils/db-retry";
import { logDiag, logDiagError } from "../utils/process-diagnostics";

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
/** Fetch reviews in batches to survive replica recovery conflicts + retry transient PG errors. */
const AI_REVIEW_FETCH_BATCH = Math.max(50, intEnv("AI_REVIEW_FETCH_BATCH", 1000));

function collapseWhitespace(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * LLM output often includes raw U+0000–U+001F inside JSON string values; `JSON.parse` rejects those.
 * Escape only inside double-quoted string literals (respects `\"` and `\\`).
 */
function escapeControlCharsInJsonStringLiterals(text: string): string {
  let out = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const code = c.charCodeAt(0);
    if (escape) {
      out += c;
      escape = false;
      continue;
    }
    if (c === "\\") {
      out += c;
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      out += c;
      continue;
    }
    if (inString && code <= 0x1f) {
      out += "\\u" + code.toString(16).padStart(4, "0");
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * LLM hay trả JSON không chuẩn: dấu phẩy thừa trước `]` hoặc `}` (trailing commas).
 * Chỉ xóa khi không nằm trong chuỗi JSON (theo dấu ngoặc kép).
 */
function removeJsonTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (escape) {
      out += c;
      escape = false;
      continue;
    }
    if (inString) {
      if (c === "\\") {
        out += c;
        escape = true;
      } else if (c === '"') {
        inString = false;
        out += c;
      } else {
        out += c;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      const next = text[j];
      if (next === "]" || next === "}") {
        continue;
      }
    }
    out += c;
  }
  return out;
}

function parseLlmJsonOutput(content: string): Record<string, unknown> {
  let cleaned = content.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }

  const variants: string[] = [
    cleaned,
    escapeControlCharsInJsonStringLiterals(cleaned),
    removeJsonTrailingCommas(cleaned),
    removeJsonTrailingCommas(escapeControlCharsInJsonStringLiterals(cleaned)),
    // hai lần — đôi khi có nhiều cấp phẩy thừa lồng nhau
    removeJsonTrailingCommas(removeJsonTrailingCommas(cleaned)),
    removeJsonTrailingCommas(removeJsonTrailingCommas(escapeControlCharsInJsonStringLiterals(cleaned))),
  ];

  let lastErr: unknown;
  for (const text of variants) {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch (e) {
      lastErr = e;
    }
  }

  const repairBases = [
    cleaned,
    escapeControlCharsInJsonStringLiterals(cleaned),
    removeJsonTrailingCommas(cleaned),
    removeJsonTrailingCommas(escapeControlCharsInJsonStringLiterals(cleaned)),
  ];
  for (const base of repairBases) {
    try {
      const repaired = jsonrepair(base);
      return JSON.parse(repaired) as Record<string, unknown>;
    } catch (e) {
      lastErr = e;
    }
  }

  const snippet = cleaned.length > 360 ? `${cleaned.slice(0, 180)} … ${cleaned.slice(-120)}` : cleaned;
  console.error("[AI Analysis] JSON.parse failed after jsonrepair + trailing-comma + control-char repairs:", lastErr);
  console.error("[AI Analysis] Response snippet:", snippet);
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
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
  "topicHints": {"gameplay":0-100,"graphics":0-100,"story":0-100,"monetization":0-100,"performance":0-100},
  "subsetSummary":"2-3 câu tiếng Việt: cảm xúc và vấn đề chính CHỈ trong lô này"
}
Chỉ số topicHints là ước lượng mức độ thảo luận trong lô này. Không cần strengths/weaknesses ở bước này.`;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queryReviewBatch(
  appId: number,
  afterId: number,
  limit: number,
  bounds: { minReviewAt: Date | null; maxReviewAt: Date | null },
): Promise<{ id: number; raw: Record<string, unknown>; reviewAt: Date | null }[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const params: unknown[] = [appId, afterId];
      let where = `"appId" = $1 AND id > $2 AND raw IS NOT NULL`;
      let paramIdx = 3;
      if (bounds.minReviewAt) {
        where += ` AND "reviewAt" >= $${paramIdx}`;
        params.push(bounds.minReviewAt);
        paramIdx++;
      }
      if (bounds.maxReviewAt) {
        where += ` AND "reviewAt" <= $${paramIdx}`;
        params.push(bounds.maxReviewAt);
        paramIdx++;
      }
      params.push(limit);
      const res = await pool.query<{ id: number; raw: Record<string, unknown>; reviewAt: Date | null }>(
        `SELECT id, raw, "reviewAt"
         FROM "AppReview"
         WHERE ${where}
         ORDER BY id ASC
         LIMIT $${paramIdx}`,
        params,
      );
      return res.rows;
    } catch (err) {
      lastErr = err;
      if (!isRetryableDbError(err) || attempt === 3) {
        logDiagError("ai-review-batch-failed", err, { appId, afterId, attempt: attempt + 1 });
        throw err;
      }
      logDiag("ai-review-batch-retry", {
        appId,
        afterId,
        attempt: attempt + 1,
        message: (err as Error).message?.slice(0, 200),
      });
      console.warn(`[AI Analysis] AppReview batch retry ${attempt + 1}/3:`, (err as Error).message);
      await sleep(250 * (attempt + 1));
    }
  }
  throw lastErr;
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

async function fetchStratifiedReviews(
  appId: number,
  window: ReviewWindow = { mode: "all" },
): Promise<StratifiedReview[]> {
  const startMs = Date.now();
  const bounds = reviewWindowSqlBounds(window);
  const rows: { raw: Record<string, unknown>; reviewAt: Date | null }[] = [];
  let afterId = 0;

  for (;;) {
    let batch: { id: number; raw: Record<string, unknown>; reviewAt: Date | null }[];
    try {
      batch = await queryReviewBatch(appId, afterId, AI_REVIEW_FETCH_BATCH, bounds);
    } catch (err) {
      console.error(`[AI Analysis] AppReview batch failed after retries for appId=${appId}:`, err);
      throw err;
    }
    if (batch.length === 0) break;
    for (const row of batch) {
      rows.push({ raw: row.raw, reviewAt: row.reviewAt });
      afterId = row.id;
    }
    if (batch.length < AI_REVIEW_FETCH_BATCH) break;
  }

  console.log(`[AI Analysis] Fetched ${rows.length} raw reviews (batched) in ${Date.now() - startMs}ms`);

  const allReviews: StratifiedReview[] = [];

  for (const row of rows) {
    try {
      const raw = row.raw;
      const review = raw?.review as Record<string, unknown> | undefined;
      const score = Math.round(Number(review?.score ?? 0));
      const bucket = RATING_BUCKETS.find((b) => score >= b.min && score <= b.max);
      const bucketLabel = bucket?.label ?? "Unrated";
      const r = parseReviewRow(row, bucketLabel);
      if (r) allReviews.push(r);
    } catch (rowErr) {
      console.warn("[AI Analysis] skip corrupt AppReview row:", (rowErr as Error).message);
    }
  }

  allReviews.sort((a, b) => {
    if (a.date === "unknown" && b.date === "unknown") return 0;
    if (a.date === "unknown") return 1;
    if (b.date === "unknown") return -1;
    return b.date.localeCompare(a.date);
  });

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

const FINAL_OUTPUT_SPEC = `Trả về một object JSON đúng cấu trúc sau (toàn bộ chuỗi tiếng Việt). ĐIỂM CHÍNH là rubricCriteria — phải đủ mọi id đã liệt kê; điểm mạnh/yếu gắn với TỪNG tiêu chí trong rubricCriteria, không dùng strengths/weaknesses tổng hợp riêng.
{
  "summaryBullets": ["3–8 gạch đầu dòng ngắn: bức tranh tổng thể từ review"],
  "recentTrendBullets": ["2–6 gạch đầu dòng: xu hướng theo thời gian nếu thấy trong dữ liệu"],
  "rubricCriteria": [ ... theo spec rubric bên dưới ... ],
  "redFlagSignals": { ... }
}

Không trả các trường: strengths, weaknesses (toàn cục), sentimentScore, sentimentBreakdown, topics — các trường đó không còn dùng.

Quy tắc:
- summaryBullets / recentTrendBullets: mỗi phần tử là MỘT string JSON duy nhất (một ý ngắn). Không đặt dấu " chưa escape trong chuỗi; không ghép kiểu text rồi ": \"giá_trị\" trong cùng một phần tử mảng — đó làm vỡ JSON.
- Red Flag: severity trong redFlagSignals (không chấm điểm); các dòng rubricCriteria có id "red_flag.*" đặt score null — xem spec rubric chi tiết.
- Với MỖI tiêu chí trong rubricCriteria: strengths và weaknesses là mảng các chuỗi ngắn riêng của tiêu chí đó (1–5 mục mỗi loại nếu có dữ liệu).`;

function buildAnalysisPrompt(
  gameName: string,
  reviews: StratifiedReview[],
  finalSpec: string,
  contextBlock: string,
  libraryBlock: string,
): string {
  const reviewBlock = buildReviewTextBlock(reviews, 1);

  return `Phân tích ${reviews.length} đánh giá người chơi cho game mobile "${gameName}".
Dữ liệu đã phân tầng theo sao 1-5 để cân bằng ý kiến tích cực và tiêu cực.
Mỗi dòng có dạng [#chỉ mục|số sao|ngày] rồi đến nội dung review.

${contextBlock}

${libraryBlock}

Research / external knowledge: When TapTap or stored metadata is incomplete, you may use widely known public facts and external signals about "${gameName}" (genre, franchise/IP, art direction, **community size via Google Trends / Steam / Discord / Reddit / forums**, developer reputation) to inform rubric reasoning. For socialization.community_size you must always output a 0–100 score even without fans_count snapshot. Cross-check any inference against the deterministic library scores above when those scores apply.

Reviews:
${reviewBlock}

${finalSpec}`;
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
  finalSpec: string,
  contextBlock: string,
  libraryBlock: string,
): string {
  return `Tổng hợp MỘT bản phân tích cho game "${gameName}" từ ${mapRawJsonStrings.length} lô trích xuất rời nhau, cùng phủ toàn bộ ${totalReviews} review đã thu thập (không bỏ sót; thứ tự lô không nhất thiết theo thời gian).

Số liệu tham chiếu:
- số review: ${totalReviews}
- số theo bucket: ${JSON.stringify(bucketCounts)}
- khoảng ngày: ${dateRange.start ?? "unknown"} .. ${dateRange.end ?? "unknown"}
- mentionCount trong rubricCriteria phải ước lượng theo % trên TOÀN BỘ ${totalReviews} review khi có thể.

${contextBlock}

${libraryBlock}

Dữ liệu từng lô (JSON, mỗi lô một khối):
${mapRawJsonStrings.map((s, i) => `--- lô ${i + 1} ---\n${s}`).join("\n\n")}

${finalSpec}`;
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

export class AIAnalysisService {
  async getAllAnalyses(userId: string): Promise<AIAnalysisResult[]> {
    return listAnalysesForUser(userId);
  }

  async getLatestAnalysis(userId: string, appId: number): Promise<AIAnalysisResult | null> {
    return getLatestAnalysisForUser(userId, appId);
  }

  async getAnalysisHistory(userId: string, appId: number): Promise<AIAnalysisResult[]> {
    return getAnalysisHistoryForUser(userId, appId);
  }

  async deleteAnalysis(userId: string, appId: number, analyzedAt: string): Promise<boolean> {
    return deleteAnalysisForUser(userId, appId, analyzedAt);
  }

  async deleteAllAnalyses(userId: string, appId: number): Promise<number> {
    return deleteAllAnalysesForUser(userId, appId);
  }

  private async runLLMAnalysis(
    userId: string,
    appId: number,
    gameName: string,
    reviews: StratifiedReview[],
    opts: {
      source?: "database" | "external" | "csv-upload" | "steam";
      iconUrl?: string | null;
      analysisContext: AnalysisContext;
      reviewWindow?: ReviewWindow;
      onProgress?: AnalysisProgressReporter;
    },
  ): Promise<AIAnalysisResult> {
    const { step: report, emit: reportEmit } = createProgressStepReporter(opts.onProgress);

    const bucketCounts = buildBucketCounts(reviews);
    const dateRange = getDateRange(reviews);
    const prepared: StratifiedReview[] = reviews.map((r) => withClippedText(r));

    report(15, `Đang chuẩn bị rubric và thư viện chấm điểm (${reviews.length} bình luận)…`, "prepare");

    const manifest = loadRubricManifest();
    const inferredPack = inferGenrePack(opts.analysisContext.tagValues);
    const activeCriteria = getActiveCriteria(manifest, inferredPack);
    const finalSpec = appendRubricSpec(FINAL_OUTPUT_SPEC, activeCriteria);
    const contextBlock = formatContextForPrompt(opts.analysisContext);
    const libraryEntries = resolveLibraryScores(opts.analysisContext, manifest);
    const libraryBlock = formatLibraryScoresForPrompt(libraryEntries);

    const model = getModel();
    const oneShot = buildAnalysisPrompt(gameName, prepared, finalSpec, contextBlock, libraryBlock);
    const estTokens = (s: string) => Math.ceil(s.length / 3);

    let content: string;

    if (oneShot.length <= AI_SINGLE_PROMPT_MAX_CHARS) {
      console.log(
        `[AI Analysis] ${gameName}: single call, ${reviews.length} reviews, model=${model}, ` +
        `~${estTokens(oneShot)} prompt tok (cap reviews=${Number.isFinite(AI_REVIEW_MAX_CHARS) ? AI_REVIEW_MAX_CHARS : "unlimited"})`
      );
      try {
        const response = await runWithLlmHeartbeat(
          reportEmit,
          28,
          74,
          `AI đang phân tích ${reviews.length} bình luận`,
          () => callLLM(SYSTEM_PROMPT, oneShot, 16_384),
        );
        content = response.content;
        report(75, "AI đã xử lý xong bình luận — đang chấm điểm rubric…", "llm");
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
      let mapCompleted = 0;
      console.log(
        `[AI Analysis] ${gameName}: map-reduce, ${reviews.length} reviews, ${totalBatches} map batches, ` +
        `concurrency=${conc}, model=${model} (single ~${estTokens(oneShot)} chars, threshold ${AI_SINGLE_PROMPT_MAX_CHARS})`
      );

      report(
        25,
        `Nhiều bình luận — AI đang xử lý theo ${totalBatches} lô (0/${totalBatches})…`,
        "llm_map",
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
        const batchStart = mapCompleted;
        const pctStart = 25 + Math.round((batchStart / totalBatches) * 48);
        const pctEnd = 25 + Math.round((Math.min(batchStart + (end - w), totalBatches) / totalBatches) * 48);
        try {
          const slice = mapChunks.slice(w, end);
          const wave = await runWithLlmHeartbeat(
            reportEmit,
            pctStart,
            Math.max(pctStart + 1, pctEnd),
            `AI đang xử lý lô ${batchStart + 1}–${Math.min(batchStart + slice.length, totalBatches)}/${totalBatches}`,
            () =>
              Promise.all(slice.map((chunk, offset) => runMapBatch(chunk, w + offset + 1))),
          );
          for (let k = 0; k < wave.length; k++) mapOut[w + k] = wave[k]!;
          mapCompleted += wave.length;
          const mapPct = 25 + Math.round((mapCompleted / totalBatches) * 48);
          report(
            mapPct,
            `AI đã xong lô ${mapCompleted}/${totalBatches} — tiếp tục…`,
            "llm_map",
          );
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
        finalSpec,
        contextBlock,
        libraryBlock,
      );
      try {
        const response = await runWithLlmHeartbeat(
          reportEmit,
          76,
          81,
          "AI đang tổng hợp kết quả các lô",
          () => callLLM(SYSTEM_REDUCE, reducePrompt, 16_384),
        );
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

    report(82, "Đang gộp điểm rubric và kiểm tra red flag…", "merge");

    const analysis = parseLlmJsonOutput(content);

    const rubric = mergeRubricFromLlm(
      manifest,
      activeCriteria,
      libraryEntries,
      parseLlmRubricRows(analysis as Record<string, unknown>),
      parseRedFlagSignals(analysis as Record<string, unknown>),
      reviews.length,
      inferredPack,
    );

    const libraryRequests = buildLibraryRequests(opts.analysisContext, libraryEntries, rubric);
    await persistLibraryRequests(opts.analysisContext, libraryRequests);

    report(92, "Đang lưu kết quả phân tích…", "save");

    const mainScore = rubric.aggregate.weightedScore ?? 50;

    const redFlagAtAGlance = buildRedFlagAtAGlance(rubric);
    const redFlagsChecklist = buildRedFlagsChecklist(rubric);

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

    const win = opts.reviewWindow ?? { mode: "all" as const };
    const winMeta = reviewWindowMeta(win);

    const result: AIAnalysisResult = {
      appId,
      gameName,
      iconUrl: opts.iconUrl ?? null,
      redFlagAtAGlance,
      redFlagsChecklist,
      source: opts.source ?? "database",
      summary,
      summaryBullets,
      strengths: [],
      weaknesses: [],
      sentimentScore: mainScore,
      sentimentBreakdown: undefined,
      topics: {},
      recentTrend,
      recentTrendBullets: recentTrendBullets.length > 0 ? recentTrendBullets : undefined,
      reviewsAnalyzed: reviews.length,
      bucketCounts,
      dateRangeStart: dateRange.start,
      dateRangeEnd: dateRange.end,
      analyzedAt: new Date().toISOString(),
      ...winMeta,
      developerName: opts.analysisContext.developerName,
      publisherName: opts.analysisContext.publisherName,
      rubric,
      libraryRequests,
    };

    await saveAnalysisForUser(userId, result);

    console.log(`[AI Analysis] ${gameName}: saved for user ${userId}`);

    report(100, "Hoàn tất phân tích AI.", "done");

    return result;
  }

  /** Có review trong DB → phân tích nhanh, không cần proxy TapTap. */
  async countDatabaseReviews(appId: number): Promise<number> {
    return withDbRetry(
      () => prisma.appReview.count({ where: { appId } }),
      `ai-review-count-${appId}`,
    );
  }

  async analyzeGameReviews(
    userId: string,
    appId: number,
    reviewWindow: ReviewWindow = { mode: "all" },
    onProgress?: AnalysisProgressReporter,
    progressFloor = 0,
  ): Promise<AIAnalysisResult> {
    const { step: report, emit: reportEmit } = createProgressStepReporter(onProgress, progressFloor);

    logDiag("ai-analysis-start", {
      appId,
      userId: userId.slice(0, 8),
      reviewWindowMode: reviewWindow.mode,
    });

    report(
      Math.max(4, progressFloor),
      progressFloor > 4
        ? "Đang tải bình luận từ CSDL (theo khoảng đã chọn)…"
        : "Đang tải bình luận từ cơ sở dữ liệu…",
      "fetch",
    );

    const latestRank = await withDbRetry(
      () =>
        prisma.appRank.findFirst({
          where: { appId },
          orderBy: { date: "desc" },
        }),
      `ai-rank-meta-${appId}`,
    );

    const gameName =
      (latestRank?.raw as TapTapRawApp | null)?.title ?? `App #${appId}`;
    const iconUrl =
      (latestRank?.raw as TapTapRawApp | null)?.icon?.url ?? null;

    let reviews = await fetchStratifiedReviews(appId, reviewWindow);
    if (reviewWindow.mode !== "all") {
      reviews = filterReviewsByWindow(reviews, reviewWindow);
    }

    if (reviews.length === 0) {
      logDiag("ai-analysis-no-reviews", { appId, gameName });
      throw new Error(`No reviews found for ${gameName} (appId: ${appId})`);
    }

    logDiag("ai-analysis-reviews-loaded", { appId, reviewCount: reviews.length, gameName });

    report(
      Math.max(10, progressFloor + 2),
      `Đã tải ${reviews.length} bình luận — bắt đầu phân tích AI…`,
      "fetch",
    );

    const analysisContext = buildAnalysisContextFromRaw(
      appId,
      gameName,
      iconUrl,
      (latestRank?.raw ?? null) as TapTapRawApp | Record<string, unknown> | null,
    );

    try {
      const result = await this.runLLMAnalysis(userId, appId, gameName, reviews, {
        source: "database",
        iconUrl,
        analysisContext,
        reviewWindow,
        onProgress: reportEmit,
      });
      logDiag("ai-analysis-done", { appId, reviewCount: reviews.length });
      return result;
    } catch (err) {
      logDiagError("ai-analysis-failed", err, { appId, reviewCount: reviews.length });
      throw err;
    }
  }

  async analyzeExternalReviews(
    userId: string,
    appId: number,
    gameName: string,
    iconUrl: string | null,
    reviews: StratifiedReview[],
    source: "external" | "csv-upload" | "steam" = "external",
    tapTapDetailRaw?: Record<string, unknown> | null,
    reviewWindow: ReviewWindow = { mode: "all" },
    onProgress?: AnalysisProgressReporter,
    progressFloor = 0,
  ): Promise<AIAnalysisResult> {
    const { step: report, emit: reportEmit } = createProgressStepReporter(onProgress, progressFloor);

    logDiag("ai-analysis-start", {
      appId,
      source,
      userId: userId.slice(0, 8),
      reviewCount: reviews.length,
      reviewWindowMode: reviewWindow.mode,
    });

    report(
      Math.max(12, progressFloor),
      "Đang lọc bình luận theo khoảng thời gian đã chọn…",
      "filter",
    );

    const filtered = filterReviewsByWindow(reviews, reviewWindow);

    if (filtered.length === 0) {
      logDiag("ai-analysis-no-reviews", { appId, gameName, source });
      throw new Error(`No reviews found for ${gameName} (appId: ${appId})`);
    }

    logDiag("ai-analysis-reviews-loaded", {
      appId,
      reviewCount: filtered.length,
      gameName,
      source,
    });

    report(
      Math.max(14, progressFloor + 1),
      `${filtered.length} bình luận sau lọc — chuẩn bị AI…`,
      "filter",
    );

    const analysisContext = buildAnalysisContextFromRaw(
      appId,
      gameName,
      iconUrl,
      source === "csv-upload" ? null : tapTapDetailRaw ?? null,
    );

    try {
      const result = await this.runLLMAnalysis(userId, appId, gameName, filtered, {
        source,
        iconUrl,
        analysisContext,
        reviewWindow,
        onProgress: reportEmit,
      });
      logDiag("ai-analysis-done", { appId, reviewCount: filtered.length, source });
      return result;
    } catch (err) {
      logDiagError("ai-analysis-failed", err, {
        appId,
        reviewCount: filtered.length,
        source,
      });
      throw err;
    }
  }
}

export const aiAnalysisService = new AIAnalysisService();
