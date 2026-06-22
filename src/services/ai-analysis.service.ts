import { callLLM, getModel } from "../utils/ai-client";
import { pool } from "../utils/prisma";
import { prisma } from "../utils/prisma";
import type { AIAnalysisResult, TapTapRawApp, PotentialBreakdown, AnalysisPrepareResult, AnalysisPrepareExistingItem, GenrePackPlan } from "../types";
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
import { buildAnalysisContextFromRaw, loadAnalysisContext, type AnalysisContext } from "./analysis-context";
import { getActiveCriteriaForPacks, loadRubricManifest } from "./rubric-manifest";
import {
  appendRubricSpec,
  formatContextForPrompt,
  formatLibraryScoresForPrompt,
  mergeRubricFromLlm,
  parseLlmRubricRows,
  parseRedFlagSignals,
  resolveLibraryScores,
  inferAllGenrePacks,
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
  getAnalysisById as fetchStoredAnalysisById,
  getAnalysisByKey as fetchStoredAnalysisByKey,
  getAnalysisHistoryForApp,
  getLatestAnalysisForApp,
  getLatestAnalysisForUser,
  listAllAnalyses,
  listAnalysesForUser,
  saveAnalysisForUser,
} from "./ai-analysis-store";
import { isRetryableDbError, withDbRetry } from "../utils/db-retry";
import { runDbQuery } from "../utils/db-diagnostics";
import { classifyPgError, serializePgError } from "../utils/pg-error";
import { aiInfoLog, aiVerboseLog } from "../utils/ai-logger";
import { logDiag, logDiagBrief, logDiagVerbose, logDbError } from "../utils/process-diagnostics";
import {
  inferGenrePackPlanWithAI,
  getDistinctGenrePackIds,
  genrePackPlanFromBody,
} from "./genre-pack-inference";
import {
  parseAppIdFromInput,
  fetchAppInfo,
  fetchAppDetailRaw,
} from "./taptap-client.service";
import {
  parseSteamAppIdFromInput,
  fetchSteamAppDetails,
  buildSteamDetailRaw,
} from "./steam-client.service";
import { parseCsvBuffer } from "../utils/csv-parser";
import {
  APP_REVIEW_LIGHT_SELECT,
  APP_REVIEW_SAMPLE_ORDER_SQL,
} from "../utils/app-review-sql";
import { buildDbFetchProgress } from "../utils/analysis-progress-copy";
import {
  AI_MAX_REVIEWS_FOR_ANALYSIS,
  AI_STRATIFY_TIME_BUCKETS,
  allocateTimeBucketLimits,
  buildTimeSlices,
  AI_DB_STRATIFIED_THRESHOLD,
  capReviewsForAnalysis,
  capStratifiedReviews,
  type StratifiedCapResult,
} from "../utils/review-stratified-cap";

const RATING_BUCKETS = [
  { label: "Very Negative", min: 1, max: 1 },
  { label: "Negative", min: 2, max: 2 },
  { label: "Mixed", min: 3, max: 3 },
  { label: "Positive", min: 4, max: 4 },
  { label: "Very Positive", min: 5, max: 5 },
] as const;

function hashStringToNumber(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

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
const AI_REVIEW_FETCH_BATCH = Math.max(50, intEnv("AI_REVIEW_FETCH_BATCH", 2000));

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

interface ReviewFetchRow {
  id?: number;
  reviewText?: string | null;
  reviewScore?: number | null;
  reviewAt: Date | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queryReviewBatch(
  appId: number,
  afterId: number,
  limit: number,
  bounds: { minReviewAt: Date | null; maxReviewAt: Date | null },
  batchIndex: number,
): Promise<ReviewFetchRow[]> {
  const label = `ai-AppReview-batch-${appId}`;
  const windowTag =
    bounds.minReviewAt && bounds.maxReviewAt
      ? `${bounds.minReviewAt.toISOString().slice(0, 10)}..${bounds.maxReviewAt.toISOString().slice(0, 10)}`
      : bounds.minReviewAt
        ? `from-${bounds.minReviewAt.toISOString().slice(0, 10)}`
        : bounds.maxReviewAt
          ? `to-${bounds.maxReviewAt.toISOString().slice(0, 10)}`
          : "all";

  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const rows = await runDbQuery(
        label,
        async () => {
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
          const res = await pool.query<ReviewFetchRow & { id: number }>(
            `SELECT ${APP_REVIEW_LIGHT_SELECT}
         FROM "AppReview"
         WHERE ${where}
         ORDER BY id ASC
         LIMIT $${paramIdx}`,
            params,
          );
          return res.rows;
        },
        {
          appId,
          afterId,
          batchIndex,
          batchLimit: limit,
          reviewWindow: windowTag,
          dbAttempt: attempt + 1,
        },
        { maxAttempts: 1, delayMs: 0 },
      );

      if (rows.length > 0 || batchIndex === 1) {
        const every10 = batchIndex === 1 || batchIndex % 10 === 0;
        if (every10) {
          logDiagVerbose("ai-review-batch-ok", {
            appId,
            batchIndex,
            rowCount: rows.length,
            afterId,
            lastId: rows.length > 0 ? rows[rows.length - 1]!.id : afterId,
            reviewWindow: windowTag,
          });
        }
      }
      return rows;
    } catch (err) {
      lastErr = err;
      if (!isRetryableDbError(err) || attempt === 3) {
        logDbError("ai-review-batch-failed", err, {
          appId,
          afterId,
          batchIndex,
          attempt: attempt + 1,
          reviewWindow: windowTag,
        });
        throw err;
      }
      logDiagBrief("ai-review-batch-retry", {
        appId,
        batchIndex,
        attempt: attempt + 1,
        reviewWindow: windowTag,
        dbKind: classifyPgError(err),
        message: serializePgError(err).message,
      });
      await sleep(250 * (attempt + 1));
    }
  }
  throw lastErr;
}

function parseReviewRow(row: ReviewFetchRow, bucketLabel: string): StratifiedReview | null {
  const text = String(row.reviewText ?? "").trim();
  if (text.length < 5) return null;

  const score = Math.round(Number(row.reviewScore ?? 0));
  const date = row.reviewAt
    ? row.reviewAt.toISOString().slice(0, 10)
    : "unknown";

  return { text, score, date, bucket: bucketLabel };
}

type ReviewFetchBatchProgress = (info: {
  batchIndex: number;
  totalRows: number;
  totalInWindow?: number;
  capped?: boolean;
  stepTotal?: number;
}) => void;

type FetchStratifiedResult = StratifiedCapResult<StratifiedReview>;

function appendWindowBoundsSql(
  bounds: { minReviewAt: Date | null; maxReviewAt: Date | null },
  params: unknown[],
  startIdx: number,
): { where: string; nextIdx: number } {
  let where = "";
  let idx = startIdx;
  if (bounds.minReviewAt) {
    where += ` AND "reviewAt" >= $${idx}`;
    params.push(bounds.minReviewAt);
    idx++;
  }
  if (bounds.maxReviewAt) {
    where += ` AND "reviewAt" <= $${idx}`;
    params.push(bounds.maxReviewAt);
    idx++;
  }
  return { where, nextIdx: idx };
}

async function countReviewsInWindow(
  appId: number,
  bounds: { minReviewAt: Date | null; maxReviewAt: Date | null },
): Promise<number> {
  return withDbRetry(async () => {
    const params: unknown[] = [appId];
    const extra = appendWindowBoundsSql(bounds, params, 2);
    const res = await pool.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt FROM "AppReview" WHERE "appId" = $1 AND raw IS NOT NULL${extra.where}`,
      params,
    );
    return res.rows[0]?.cnt ?? 0;
  }, `ai-review-count-window-${appId}`);
}

function parseRowsToStratifiedReviews(
  rows: ReviewFetchRow[],
): { reviews: StratifiedReview[]; corruptSkipped: number } {
  const out: StratifiedReview[] = [];
  let corruptSkipped = 0;
  for (const row of rows) {
    try {
      const score = Math.round(Number(row.reviewScore ?? 0));
      const bucket = RATING_BUCKETS.find((b) => score >= b.min && score <= b.max);
      const bucketLabel = bucket?.label ?? "Unrated";
      const r = parseReviewRow(row, bucketLabel);
      if (r) out.push(r);
    } catch {
      corruptSkipped++;
    }
  }
  return { reviews: out, corruptSkipped };
}

async function queryReviewsInTimeBucket(
  appId: number,
  bounds: { minReviewAt: Date | null; maxReviewAt: Date | null },
  opts: {
    limit: number;
    timeStart?: Date;
    timeEnd?: Date;
    reviewAtIsNull?: boolean;
  },
): Promise<ReviewFetchRow[]> {
  const params: unknown[] = [appId];
  let where = `"appId" = $1 AND raw IS NOT NULL`;
  let idx = 2;
  const extra = appendWindowBoundsSql(bounds, params, idx);
  where += extra.where;
  idx = extra.nextIdx;

  if (opts.reviewAtIsNull) {
    where += ` AND "reviewAt" IS NULL`;
  } else if (opts.timeStart && opts.timeEnd) {
    where += ` AND "reviewAt" >= $${idx} AND "reviewAt" < $${idx + 1}`;
    params.push(opts.timeStart, opts.timeEnd);
    idx += 2;
  }

  params.push(opts.limit);
  const res = await pool.query<ReviewFetchRow>(
    `SELECT ${APP_REVIEW_LIGHT_SELECT}
     FROM "AppReview"
     WHERE ${where}
     ORDER BY ${APP_REVIEW_SAMPLE_ORDER_SQL}
     LIMIT $${idx}`,
    params,
  );
  return res.rows;
}

function stratifiedReviewKey(r: StratifiedReview): string {
  return `${r.date}|${r.score}|${r.text.slice(0, 120)}`;
}

/** Bổ sung review khi lấy mẫu theo khung thời gian chưa đủ tới `target`. */
async function topUpStratifiedReviews(
  appId: number,
  bounds: { minReviewAt: Date | null; maxReviewAt: Date | null },
  collected: StratifiedReview[],
  target: number,
  onBatchProgress?: ReviewFetchBatchProgress,
): Promise<StratifiedReview[]> {
  const goal = Math.min(target, collected.length + 500_000);
  if (collected.length >= goal) return collected;

  const seen = new Set(collected.map(stratifiedReviewKey));
  const out = [...collected];
  let afterId = 0;
  let batchIndex = 0;

  while (out.length < goal) {
    batchIndex++;
    const batch = await queryReviewBatch(appId, afterId, AI_REVIEW_FETCH_BATCH, bounds, batchIndex);
    if (batch.length === 0) break;

    for (const row of batch) {
      afterId = row.id ?? afterId;
      try {
        const score = Math.round(Number(row.reviewScore ?? 0));
        const bucket = RATING_BUCKETS.find((b) => score >= b.min && score <= b.max);
        const bucketLabel = bucket?.label ?? "Unrated";
        const parsed = parseReviewRow(row, bucketLabel);
        if (!parsed) continue;
        const key = stratifiedReviewKey(parsed);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(parsed);
        if (out.length >= goal) break;
      } catch {
        /* skip corrupt */
      }
    }

    onBatchProgress?.({
      batchIndex,
      totalRows: out.length,
      capped: true,
    });

    if (batch.length < AI_REVIEW_FETCH_BATCH) break;
  }

  return out;
}

async function fetchStratifiedReviewsSampled(
  appId: number,
  bounds: { minReviewAt: Date | null; maxReviewAt: Date | null },
  totalInWindow: number,
  onBatchProgress?: ReviewFetchBatchProgress,
): Promise<FetchStratifiedResult> {
  const startMs = Date.now();
  const rangeRes = await withDbRetry(
    () =>
      pool.query<{ min: Date | null; max: Date | null; nulls: number }>(
        `SELECT MIN("reviewAt") AS min, MAX("reviewAt") AS max,
                COUNT(*) FILTER (WHERE "reviewAt" IS NULL)::int AS nulls
         FROM "AppReview"
         WHERE "appId" = $1 AND raw IS NOT NULL`,
        [appId],
      ),
    `ai-review-date-range-${appId}`,
  );
  const minAt = rangeRes.rows[0]?.min;
  const maxAt = rangeRes.rows[0]?.max;
  const nullDates = rangeRes.rows[0]?.nulls ?? 0;

  const { perBucket, bucketCount } = allocateTimeBucketLimits(
    AI_MAX_REVIEWS_FOR_ANALYSIS,
    AI_STRATIFY_TIME_BUCKETS,
    nullDates > 0,
  );

  let collected: StratifiedReview[] = [];
  let corruptSkipped = 0;
  let bucketIndex = 0;
  const stepTotal = bucketCount;

  const fetchBucket = async (
    label: string,
    opts: {
      limit: number;
      timeStart?: Date;
      timeEnd?: Date;
      reviewAtIsNull?: boolean;
    },
  ) => {
    bucketIndex++;
    const rows = await withDbRetry(
      () => queryReviewsInTimeBucket(appId, bounds, opts),
      `ai-time-bucket-${appId}-${label}`,
    );
    const parsed = parseRowsToStratifiedReviews(rows);
    corruptSkipped += parsed.corruptSkipped;
    collected.push(...parsed.reviews);
    onBatchProgress?.({
      batchIndex: bucketIndex,
      totalRows: collected.length,
      totalInWindow,
      capped: true,
      stepTotal,
    });
  };

  if (minAt && maxAt) {
    const slices = buildTimeSlices(minAt, maxAt, AI_STRATIFY_TIME_BUCKETS);
    for (let i = 0; i < slices.length; i++) {
      const slice = slices[i]!;
      await fetchBucket(`t${i}`, {
        limit: perBucket,
        timeStart: slice.start,
        timeEnd: slice.end,
      });
    }
  } else {
    await fetchBucket("all", { limit: perBucket });
  }

  if (nullDates > 0) {
    await fetchBucket("unknown-date", {
      limit: perBucket,
      reviewAtIsNull: true,
    });
  }

  const beforeTopUp = collected.length;
  if (collected.length < AI_MAX_REVIEWS_FOR_ANALYSIS) {
    collected = await topUpStratifiedReviews(
      appId,
      bounds,
      collected,
      AI_MAX_REVIEWS_FOR_ANALYSIS,
      onBatchProgress,
    );
    if (collected.length > beforeTopUp) {
      aiInfoLog(
        `[AI Analysis] appId=${appId}: top-up stratified sample ${beforeTopUp} → ${collected.length} (target ${AI_MAX_REVIEWS_FOR_ANALYSIS})`,
      );
    }
  }

  const capped = capStratifiedReviews(collected, AI_MAX_REVIEWS_FOR_ANALYSIS);

  if (corruptSkipped > 0) {
    logDiagBrief("ai-review-corrupt-skipped", { appId, corruptSkipped });
  }

  logDiagBrief("ai-fetch-reviews-done", {
    appId,
    reviewWindowMode: "sampled",
    rawRows: capped.reviews.length,
    totalInWindow,
    capped: true,
    timeBucketsQueried: bucketIndex,
    durationMs: Date.now() - startMs,
  });

  aiInfoLog(
    `[AI Analysis] Time-stratified sample ${capped.reviews.length}/${totalInWindow} reviews (${bucketIndex} time buckets) in ${Date.now() - startMs}ms`,
  );

  return {
    reviews: capped.reviews,
    totalBeforeCap: totalInWindow,
    capped: totalInWindow > AI_MAX_REVIEWS_FOR_ANALYSIS,
  };
}

async function fetchStratifiedReviewsFull(
  appId: number,
  bounds: { minReviewAt: Date | null; maxReviewAt: Date | null },
  onBatchProgress?: ReviewFetchBatchProgress,
): Promise<StratifiedReview[]> {
  const startMs = Date.now();
  const rows: ReviewFetchRow[] = [];
  let afterId = 0;
  let batchIndex = 0;

  for (;;) {
    batchIndex++;
    const batch = await queryReviewBatch(appId, afterId, AI_REVIEW_FETCH_BATCH, bounds, batchIndex);
    if (batch.length === 0) break;
    for (const row of batch) {
      rows.push(row);
      if (row.id != null) afterId = row.id;
    }
    onBatchProgress?.({ batchIndex, totalRows: rows.length });
    if (batch.length < AI_REVIEW_FETCH_BATCH) break;
  }

  const parsed = parseRowsToStratifiedReviews(rows);
  if (parsed.corruptSkipped > 0) {
    logDiagBrief("ai-review-corrupt-skipped", { appId, corruptSkipped: parsed.corruptSkipped });
  }
  const allReviews = parsed.reviews;
  allReviews.sort((a, b) => {
    if (a.date === "unknown" && b.date === "unknown") return 0;
    if (a.date === "unknown") return 1;
    if (b.date === "unknown") return -1;
    return b.date.localeCompare(a.date);
  });

  aiInfoLog(`[AI Analysis] Fetched ${allReviews.length} raw reviews (batched) in ${Date.now() - startMs}ms`);
  return allReviews;
}

async function fetchStratifiedReviews(
  appId: number,
  window: ReviewWindow = { mode: "all" },
  onBatchProgress?: ReviewFetchBatchProgress,
): Promise<FetchStratifiedResult> {
  const startMs = Date.now();
  const bounds = reviewWindowSqlBounds(window);
  const totalInWindow = await countReviewsInWindow(appId, bounds);
  const overMax = totalInWindow > AI_MAX_REVIEWS_FOR_ANALYSIS;
  const useDbCellSample = totalInWindow > AI_DB_STRATIFIED_THRESHOLD;

  logDiagBrief("ai-fetch-reviews-start", {
    appId,
    reviewWindowMode: window.mode,
    reviewWindowDays: window.mode === "days" ? window.days : undefined,
    totalInWindow,
    maxReviews: AI_MAX_REVIEWS_FOR_ANALYSIS,
    stratifiedCap: overMax,
    fetchMode: !overMax ? "full" : useDbCellSample ? "db_time_buckets" : "full_then_cap",
  });

  if (!overMax) {
    aiInfoLog(
      `[AI Analysis] appId=${appId}: ${totalInWindow} reviews — loading all (no sampling)`,
    );
    const reviews = await fetchStratifiedReviewsFull(appId, bounds, onBatchProgress);
    logDiagBrief("ai-fetch-reviews-done", {
      appId,
      reviewWindowMode: window.mode,
      rawRows: reviews.length,
      totalInWindow,
      capped: false,
      durationMs: Date.now() - startMs,
    });
    return { reviews, totalBeforeCap: totalInWindow, capped: false };
  }

  if (!useDbCellSample) {
    aiInfoLog(
      `[AI Analysis] appId=${appId}: ${totalInWindow} reviews — full load then cap at ${AI_MAX_REVIEWS_FOR_ANALYSIS}`,
    );
    const reviews = await fetchStratifiedReviewsFull(appId, bounds, onBatchProgress);
    const capped = capStratifiedReviews(reviews, AI_MAX_REVIEWS_FOR_ANALYSIS);
    logDiagBrief("ai-fetch-reviews-done", {
      appId,
      reviewWindowMode: window.mode,
      rawRows: capped.reviews.length,
      totalInWindow,
      capped: true,
      durationMs: Date.now() - startMs,
    });
    return { ...capped, totalBeforeCap: totalInWindow, capped: true };
  }

  aiInfoLog(
    `[AI Analysis] appId=${appId}: ${totalInWindow} reviews — DB stratified sample up to ${AI_MAX_REVIEWS_FOR_ANALYSIS}`,
  );
  return fetchStratifiedReviewsSampled(appId, bounds, totalInWindow, onBatchProgress);
}

function applyCapNoteToResult(
  result: AIAnalysisResult,
  cap: StratifiedCapResult<StratifiedReview>,
): AIAnalysisResult {
  if (!cap.capped) return result;
  const note = `Phân tích trên ${cap.reviews.length.toLocaleString("vi-VN")} / ${cap.totalBeforeCap.toLocaleString("vi-VN")} bình luận (giới hạn ${AI_MAX_REVIEWS_FOR_ANALYSIS.toLocaleString("vi-VN")}, phân tầng theo thời gian).`;
  return {
    ...result,
    reviewsTotalInWindow: cap.totalBeforeCap,
    reviewsCapped: true,
    summaryBullets: [note, ...(result.summaryBullets ?? [])],
    summary: [note, result.summary].filter(Boolean).join("\n"),
  };
}

function buildBucketCounts(reviews: StratifiedReview[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const b of RATING_BUCKETS) counts[b.label] = 0;
  for (const r of reviews) counts[r.bucket] = (counts[r.bucket] ?? 0) + 1;
  return counts;
}

/** Compact count formatter (K/M) for data-performance bullets. */
function formatCount(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`;
  return `${Math.round(n)}`;
}

function pctOf(n: number, total: number): number {
  return total > 0 ? Math.round((n / total) * 1000) / 10 : 0;
}

/**
 * Data-performance bullets with interpretation — numbers are exact; each line explains why it matters.
 */
function buildDataPerformanceBullets(params: {
  bucketCounts: Record<string, number>;
  reviewsTotal: number;
  fansCount?: number | null;
  breakdown?: PotentialBreakdown | null;
}): string[] {
  const { bucketCounts, reviewsTotal, fansCount, breakdown } = params;
  const bullets: string[] = [];

  if (reviewsTotal > 0) {
    const vneg = bucketCounts["Very Negative"] ?? 0;
    const neg = bucketCounts["Negative"] ?? 0;
    const mix = bucketCounts["Mixed"] ?? 0;
    const pos = bucketCounts["Positive"] ?? 0;
    const vpos = bucketCounts["Very Positive"] ?? 0;
    const positive = pos + vpos;
    const negative = vneg + neg;
    const posPct = pctOf(positive, reviewsTotal);
    const negPct = pctOf(negative, reviewsTotal);
    let sentimentTake =
      posPct >= 75
        ? "đa số người chơi hài lòng — tín hiệu chất lượng tốt"
        : posPct >= 55
          ? "cảm xúc lệch tích cực nhưng vẫn còn nhóm tiêu cực đáng chú ý"
          : negPct >= 30
            ? "tỷ lệ tiêu cực cao — cần xem kỹ các vấn đề lặp lại trong review"
            : "cảm xúc trung tính, chưa có đủ tín hiệu rõ ràng";
    bullets.push(
      `Review: ${posPct}% tích cực (4–5★), ${negPct}% tiêu cực (1–2★), ${pctOf(mix, reviewsTotal)}% trung tính trên ${reviewsTotal.toLocaleString("vi-VN")} bình luận — ${sentimentTake}.`,
    );
  }

  const reserve = breakdown?.reserve ?? null;
  const launched = breakdown?.launched ?? null;
  const detail = launched ?? reserve;
  const audience = detail?.audience ?? detail?.scale;

  const rating = detail?.rating;
  if (rating?.end != null) {
    const deltaTxt =
      rating.start != null
        ? ` (${rating.delta >= 0 ? "+" : ""}${rating.delta} trong kỳ)`
        : "";
    let ratingTake =
      rating.delta > 0.05
        ? "rating đang cải thiện — được cộng đồng đón nhận tốt hơn"
        : rating.delta < -0.05
          ? "rating giảm nhẹ — cần theo dõi xem có vấn đề mới nổi không"
          : rating.end >= 9
            ? "rating cao và ổn định — chất lượng được giữ vững, không bị phạt vì không tăng thêm"
            : "rating ổn định trong kỳ";
    bullets.push(`Đánh giá: ${rating.end}★${deltaTxt} — ${ratingTake}.`);
  }

  if (audience?.end != null) {
    const metricLabel = audience.metric === "download" ? "lượt tải" : "đăng ký trước";
    const tierLabel = audience.baseTierLabel ? ` (mốc ${audience.baseTierLabel})` : "";
    const deltaTxt =
      audience.delta !== 0
        ? `, tăng thêm ${audience.delta >= 0 ? "+" : ""}${formatCount(audience.delta)}`
        : "";
    let audienceTake =
      audience.baseValue >= 80 && audience.delta > 0 && audience.delta < 50_000
        ? "quy mô đã rất lớn nên tốc độ tăng chậm lại là bình thường — vẫn là game dẫn đầu, không bị trừ điểm nặng"
        : audience.delta > 50_000
          ? "tăng trưởng mạnh so với mặt bằng — đang thu hút người chơi tích cực"
          : audience.delta < 0
            ? "quy mô giảm trong kỳ — cần xem có sự kiện âm tính hay chỉ dao động ngắn hạn"
            : audience.baseValue >= 68
              ? "quy mô lớn, duy trì ổn định — vị thế thị trường vững"
              : "quy mô còn khiêm tốn — cần tăng trưởng rõ hơn để leo hạng";
    bullets.push(
      `${metricLabel === "lượt tải" ? "Lượt tải" : "Đăng ký trước"}: ~${formatCount(audience.end)}${tierLabel}${deltaTxt} — ${audienceTake}.`,
    );
  }

  if (fansCount != null && fansCount > 0) {
    const fanTake =
      audience?.end != null && fansCount >= audience.end * 0.8
        ? "fan và quy mô chơi/đặt chỗ tương đương — cộng đồng quan tâm thật"
        : "cộng đồng theo dõi đáng kể — bổ sung cho quy mô reserve/download";
    bullets.push(`Fan/cộng đồng: ~${formatCount(fansCount)} — ${fanTake}.`);
  }

  if (detail?.rankQuality) {
    const rq = detail.rankQuality;
    let rankTake =
      rq.rankEnd <= 10
        ? "duy trì top 10 — vị thế BXH rất mạnh"
        : rq.rankEnd <= 20
          ? "nằm top 20 ổn định — game đáng chú ý trên bảng"
          : rq.change > 0
            ? "đang leo hạng — momentum BXH tích cực"
            : rq.change < 0
              ? "tụt hạng trong kỳ — cần đối chiếu với tăng trưởng số liệu"
              : "hạng ổn định nhưng chưa ở nhóm top";
    bullets.push(
      `BXH: hiện #${rq.rankEnd}, tốt nhất #${rq.bestRank} (${rq.daysTracked} ngày) — ${rankTake}.`,
    );
  }

  const compositeParts: string[] = [];
  if (reserve?.compositeScore != null) compositeParts.push(`Reserve ${reserve.compositeScore.toFixed(1)}`);
  if (launched?.compositeScore != null) compositeParts.push(`Launch ${launched.compositeScore.toFixed(1)}`);
  if (compositeParts.length > 0) {
    const top = Math.max(reserve?.compositeScore ?? 0, launched?.compositeScore ?? 0);
    const potTake =
      top >= 85
        ? "tiềm năng rất cao — nằm nhóm đầu so với mặt bằng"
        : top >= 70
          ? "tiềm năng khá — có nhiều điểm mạnh đồng thời"
          : "tiềm năng trung bình — còn mảnh cần cải thiện";
    bullets.push(`Potential: ${compositeParts.join(" · ")} / 100 — ${potTake}.`);
  }

  return bullets;
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
  "summaryBullets": ["1–3 gạch đầu dòng NGẮN bổ sung góc nhìn định tính từ review (vấn đề lặp lại, điểm nổi bật) — KHÔNG lặp lại số liệu vì hệ thống đã chèn block Data Performance kèm nhận định ở đầu Tóm tắt."],
  "recentTrendBullets": ["2–6 gạch đầu dòng: xu hướng trong KHOẢNG 60 NGÀY GẦN ĐÂY NHẤT (dựa trên ngày review mới nhất trong dữ liệu) — nêu rõ cảm xúc đang tăng/giảm/ổn định và vấn đề mới nổi gần đây"],
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
  async getAnalysisById(analysisId: string): Promise<AIAnalysisResult | null> {
    return fetchStoredAnalysisById(analysisId);
  }

  async getAnalysisByKey(
    appId: number,
    analyzedAtIso: string,
    userId?: string,
  ): Promise<AIAnalysisResult | null> {
    return fetchStoredAnalysisByKey(appId, analyzedAtIso, userId);
  }

  async getAllAnalyses(
    userId: string,
    scope: "all" | "mine" = "all",
  ): Promise<AIAnalysisResult[]> {
    return scope === "mine" ? listAnalysesForUser(userId) : listAllAnalyses();
  }

  async getLatestAnalysis(
    userId: string,
    appId: number,
    scope: "all" | "mine" = "all",
  ): Promise<AIAnalysisResult | null> {
    return scope === "mine"
      ? getLatestAnalysisForUser(userId, appId)
      : getLatestAnalysisForApp(appId);
  }

  async getAnalysisHistory(
    userId: string,
    appId: number,
    scope: "all" | "mine" = "all",
  ): Promise<AIAnalysisResult[]> {
    return scope === "mine"
      ? getAnalysisHistoryForUser(userId, appId)
      : getAnalysisHistoryForApp(appId);
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
      genrePackPlan?: GenrePackPlan | null;
    },
  ): Promise<AIAnalysisResult> {
    const { step: report, emit: reportEmit } = createProgressStepReporter(opts.onProgress);

    const bucketCounts = buildBucketCounts(reviews);
    const dateRange = getDateRange(reviews);
    const prepared: StratifiedReview[] = reviews.map((r) => withClippedText(r));

    report(15, `Đang chuẩn bị rubric và thư viện chấm điểm (${reviews.length} bình luận)…`, "prepare");

    const manifest = loadRubricManifest();
    const tagPacks = inferAllGenrePacks(opts.analysisContext.tagValues);
    let genrePackPlan = opts.genrePackPlan ?? null;
    if (!genrePackPlan) {
      genrePackPlan = await inferGenrePackPlanWithAI(opts.analysisContext, tagPacks);
    }
    const packIds = genrePackPlan.packs.map((p) => p.packId);
    const activeCriteria = getActiveCriteriaForPacks(manifest, packIds);
    const finalSpec = appendRubricSpec(FINAL_OUTPUT_SPEC, activeCriteria);
    const contextBlock = formatContextForPrompt(opts.analysisContext);
    const libraryEntries = resolveLibraryScores(opts.analysisContext, manifest);
    const libraryBlock = formatLibraryScoresForPrompt(libraryEntries);

    const model = getModel();
    const oneShot = buildAnalysisPrompt(gameName, prepared, finalSpec, contextBlock, libraryBlock);
    const estTokens = (s: string) => Math.ceil(s.length / 3);

    let content: string;

    if (oneShot.length <= AI_SINGLE_PROMPT_MAX_CHARS) {
      aiInfoLog(
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
        aiInfoLog(
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
        aiVerboseLog(
          `[AI Analysis] ${gameName}: merged map batches ${packed.length} → ${mapChunks.length} (max ${AI_MAX_MAP_CHUNKS})`,
        );
      }
      const mapOut: string[] = new Array(mapChunks.length);
      const conc = Math.min(AI_MAP_CONCURRENCY, mapChunks.length);
      const totalBatches = mapChunks.length;
      let mapCompleted = 0;
      aiInfoLog(
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
        aiVerboseLog(
          `[AI Analysis] ${gameName}: map ${batchIndex1}/${totalBatches} (reviews ${c.reviews.length}, ~${est} tok) start`
        );
        const response = await callLLM(SYSTEM_MAP, u, 4_096);
        aiVerboseLog(
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
        aiInfoLog(
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
      genrePackPlan,
    );

    const libraryRequests = buildLibraryRequests(opts.analysisContext, libraryEntries, rubric);
    await persistLibraryRequests(opts.analysisContext, libraryRequests);

    report(92, "Đang lưu kết quả phân tích…", "save");

    const mainScore = rubric.aggregate.weightedScore ?? 50;

    const redFlagAtAGlance = buildRedFlagAtAGlance(rubric);
    const redFlagsChecklist = buildRedFlagsChecklist(rubric);

    // Deterministic Data-Performance block leads the summary; AI bullets become narrative tail.
    let potentialBreakdown: PotentialBreakdown | null = null;
    if ((opts.source ?? "database") === "database" && Number.isFinite(appId)) {
      try {
        const { rankingService } = await import("./ranking.service");
        potentialBreakdown = await rankingService.getGamePotentialBreakdown(appId, 14, "combined");
      } catch (err) {
        aiVerboseLog(
          `[AI Analysis] potential breakdown unavailable for ${appId}: ${(err as Error).message}`,
        );
      }
    }
    const dataBullets = buildDataPerformanceBullets({
      bucketCounts,
      reviewsTotal: reviews.length,
      fansCount: opts.analysisContext.fansCount,
      breakdown: potentialBreakdown,
    });

    let summaryBullets = normalizeBulletArray(analysis.summaryBullets);
    if (summaryBullets.length === 0 && typeof analysis.summary === "string" && analysis.summary.trim()) {
      summaryBullets = bulletsFromLegacyParagraph(analysis.summary);
    }
    if (dataBullets.length > 0) {
      summaryBullets = [...dataBullets, ...summaryBullets];
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

    const analysisId = await saveAnalysisForUser(userId, result);

    aiInfoLog(`[AI Analysis] ${gameName}: saved for user ${userId}`);

    report(100, "Hoàn tất phân tích AI.", "done");

    return { ...result, analyzedByUserId: userId, analysisId };
  }

  /** Có review trong DB → phân tích nhanh, không cần proxy TapTap. */
  private toPrepareExistingItem(a: AIAnalysisResult): AnalysisPrepareExistingItem {
    return {
      appId: a.appId,
      gameName: a.gameName,
      analyzedAt: a.analyzedAt,
      reviewsAnalyzed: a.reviewsAnalyzed,
      score: a.rubric?.aggregate?.weightedScore ?? a.sentimentScore ?? null,
      genrePacks: a.rubric?.genrePacksResolved,
      genrePackResolved: a.rubric?.genrePackResolved ?? null,
    };
  }

  async prepareAnalysis(
    _userId: string,
    opts: {
      source: "database" | "external" | "csv";
      appId?: number;
      input?: string;
      platform?: "taptap" | "steam";
      gameName?: string;
      overridePackIds?: string[];
      csvBuffer?: Buffer;
    },
  ): Promise<AnalysisPrepareResult> {
    const manifest = loadRubricManifest();
    const availablePackIds = getDistinctGenrePackIds(manifest);

    let appId = opts.appId ?? 0;
    let gameName = opts.gameName ?? "";
    let iconUrl: string | null = null;
    let analysisContext: AnalysisContext;

    if (opts.source === "database") {
      if (!appId || appId <= 0) throw new Error("appId required for database prepare");
      const ctx = await loadAnalysisContext(appId);
      if (!ctx) throw new Error(`Game not found (appId: ${appId})`);
      analysisContext = ctx;
      gameName = ctx.gameName;
      iconUrl = ctx.iconUrl;
    } else if (opts.source === "csv") {
      if (!opts.csvBuffer) throw new Error("CSV file required for csv prepare");
      const { gameName: csvName, appId: csvAppId } = parseCsvBuffer(opts.csvBuffer);
      gameName = csvName;
      appId = /^\d+$/.test(csvAppId) ? Number(csvAppId) : hashStringToNumber(csvAppId);
      analysisContext = buildAnalysisContextFromRaw(appId, gameName, null, null);
    } else {
      const input = String(opts.input ?? "").trim();
      if (!input) throw new Error("input required for external prepare");
      const platform = opts.platform === "steam" ? "steam" : "taptap";

      if (platform === "steam") {
        const steamAppId = parseSteamAppIdFromInput(input);
        if (!steamAppId || steamAppId <= 0) throw new Error("Invalid Steam URL or App ID");
        appId = steamAppId;
        const appData = await fetchSteamAppDetails(steamAppId);
        gameName =
          appData && typeof appData.name === "string" && appData.name.trim()
            ? appData.name.trim()
            : `Steam App ${steamAppId}`;
        iconUrl = appData && typeof appData.header_image === "string" ? appData.header_image : null;
        const detailRaw = appData ? buildSteamDetailRaw(appData, steamAppId) : null;
        analysisContext = buildAnalysisContextFromRaw(appId, gameName, iconUrl, detailRaw);
      } else {
        const tapAppId = parseAppIdFromInput(input);
        if (!tapAppId || tapAppId <= 0) throw new Error("Invalid TapTap URL or App ID");
        appId = tapAppId;
        const dbCtx = await loadAnalysisContext(appId);
        if (dbCtx) {
          analysisContext = dbCtx;
          gameName = dbCtx.gameName;
          iconUrl = dbCtx.iconUrl;
        } else {
          const appInfo = await fetchAppInfo(appId);
          const detailRaw = await fetchAppDetailRaw(appId);
          gameName = appInfo.title;
          iconUrl = appInfo.iconUrl;
          analysisContext = buildAnalysisContextFromRaw(appId, gameName, iconUrl, detailRaw);
        }
      }
    }

    const tagInferredPacks = inferAllGenrePacks(analysisContext.tagValues);
    const genrePackPlan = await inferGenrePackPlanWithAI(
      analysisContext,
      tagInferredPacks,
      opts.overridePackIds,
    );

    const history = await getAnalysisHistoryForApp(appId);
    const existingAnalyses = history.map((h) => this.toPrepareExistingItem(h));

    return {
      appId,
      gameName,
      iconUrl,
      tagInferredPacks,
      availablePackIds,
      genrePackPlan,
      existingAnalyses,
    };
  }

  parseGenrePacksFromRequest(body: unknown): GenrePackPlan | null {
    let raw = (body as { genrePacks?: unknown })?.genrePacks;
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    }
    return genrePackPlanFromBody(raw);
  }

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
    genrePackPlan?: GenrePackPlan | null,
  ): Promise<AIAnalysisResult> {
    const { step: report, emit: reportEmit } = createProgressStepReporter(onProgress, progressFloor);

    const dbReviewTotal = await withDbRetry(
      () => prisma.appReview.count({ where: { appId } }),
      `ai-review-count-total-${appId}`,
    );

    logDiagBrief("ai-analysis-start", {
      appId,
      userId: userId.slice(0, 8),
      reviewWindowMode: reviewWindow.mode,
      reviewWindowDays: reviewWindow.mode === "days" ? reviewWindow.days : undefined,
      dbReviewTotalInApp: dbReviewTotal,
    });

    report(
      Math.max(4, progressFloor),
      "Đang chuẩn bị dữ liệu bình luận từ cơ sở dữ liệu…",
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

    let capMeta = await fetchStratifiedReviews(
      appId,
      reviewWindow,
      ({ batchIndex, totalRows, totalInWindow, capped, stepTotal }) => {
        const est = capped
          ? (stepTotal ?? AI_STRATIFY_TIME_BUCKETS + 1)
          : totalInWindow
            ? Math.max(1, Math.ceil(totalInWindow / AI_REVIEW_FETCH_BATCH))
            : batchIndex + 5;
        const pct = capped
          ? Math.min(
              progressFloor + 22,
              progressFloor + 2 + Math.floor((batchIndex / Math.max(est, 1)) * 20),
            )
          : Math.min(9, 4 + Math.min(5, batchIndex));
        const { message, detail } = buildDbFetchProgress({
          batchIndex,
          collected: totalRows,
          totalInWindow,
          capped,
          stepTotal: est,
          fullFetchBatchEstimate: est,
        });
        report(pct, message, "fetch", detail);
      },
    );
    let reviews = capMeta.reviews;
    if (reviewWindow.mode !== "all") {
      const filtered = filterReviewsByWindow(reviews, reviewWindow);
      if (filtered.length !== reviews.length) {
        capMeta = capReviewsForAnalysis(filtered);
        reviews = capMeta.reviews;
      }
    }

    if (reviews.length === 0) {
      logDiag("ai-analysis-no-reviews", { appId, gameName });
      throw new Error(`No reviews found for ${gameName} (appId: ${appId})`);
    }

    logDiagBrief("ai-analysis-reviews-loaded", {
      appId,
      reviewCount: reviews.length,
      totalInWindow: capMeta.totalBeforeCap,
      capped: capMeta.capped,
      gameName,
    });

    const loadMsg = capMeta.capped
      ? `Đã chọn ${reviews.length.toLocaleString("vi-VN")} bình luận đại diện (từ ${capMeta.totalBeforeCap.toLocaleString("vi-VN")} trong khoảng) — bắt đầu phân tích AI…`
      : `Đã tải ${reviews.length.toLocaleString("vi-VN")} bình luận — bắt đầu phân tích AI…`;
    report(Math.max(10, progressFloor + 2), loadMsg, "fetch", {
      collected: reviews.length,
      total: capMeta.totalBeforeCap,
      capped: capMeta.capped,
    });

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
        genrePackPlan,
      });
      logDiagBrief("ai-analysis-done", { appId, reviewCount: reviews.length, capped: capMeta.capped });
      return applyCapNoteToResult(result, capMeta);
    } catch (err) {
      logDbError("ai-analysis-failed", err, { appId, reviewCount: reviews.length });
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
    genrePackPlan?: GenrePackPlan | null,
  ): Promise<AIAnalysisResult> {
    const { step: report, emit: reportEmit } = createProgressStepReporter(onProgress, progressFloor);

    logDiagBrief("ai-analysis-start", {
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

    let capMeta = capReviewsForAnalysis(filterReviewsByWindow(reviews, reviewWindow));
    const filtered = capMeta.reviews;

    if (filtered.length === 0) {
      logDiag("ai-analysis-no-reviews", { appId, gameName, source });
      throw new Error(`No reviews found for ${gameName} (appId: ${appId})`);
    }

    logDiagBrief("ai-analysis-reviews-loaded", {
      appId,
      reviewCount: filtered.length,
      totalInWindow: capMeta.totalBeforeCap,
      capped: capMeta.capped,
      gameName,
      source,
    });

    const filterMsg = capMeta.capped
      ? `Đã chọn ${filtered.length.toLocaleString("vi-VN")} bình luận đại diện (từ ${capMeta.totalBeforeCap.toLocaleString("vi-VN")} sau lọc) — chuẩn bị AI…`
      : `${filtered.length.toLocaleString("vi-VN")} bình luận sau lọc — chuẩn bị AI…`;
    report(Math.max(14, progressFloor + 1), filterMsg, "filter", {
      collected: filtered.length,
      total: capMeta.totalBeforeCap,
      capped: capMeta.capped,
    });

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
        genrePackPlan,
      });
      logDiagBrief("ai-analysis-done", { appId, reviewCount: filtered.length, source, capped: capMeta.capped });
      return applyCapNoteToResult(result, capMeta);
    } catch (err) {
      logDbError("ai-analysis-failed", err, {
        appId,
        reviewCount: filtered.length,
        source,
      });
      throw err;
    }
  }
}

export const aiAnalysisService = new AIAnalysisService();
