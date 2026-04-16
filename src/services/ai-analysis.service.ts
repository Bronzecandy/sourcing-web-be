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

const SYSTEM_PROMPT = `You are a senior game industry analyst specializing in mobile gaming market intelligence.
You will receive user reviews from TapTap (a Chinese game platform), stratified across all rating levels (1-5 stars).
Reviews may be in Chinese, English, or mixed. Analyze them thoroughly and respond in ENGLISH only.
You MUST respond with ONLY a valid JSON object. No markdown fences, no explanation, no extra text before or after the JSON.`;

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

function buildAnalysisPrompt(gameName: string, reviews: StratifiedReview[]): string {
  const reviewBlock = reviews
    .map(
      (r, i) =>
        `[#${i + 1} | Rating: ${r.score}/5 | Date: ${r.date} | Bucket: ${r.bucket}]\n${r.text}`
    )
    .join("\n---\n");

  return `Analyze the following ${reviews.length} player reviews for the mobile game "${gameName}" from TapTap.
Reviews are stratified across all rating levels (1-5 stars) to ensure balanced coverage of both positive and negative feedback.
Each review includes its star rating (1-5), date, and sentiment bucket.

Reviews:
${reviewBlock}

Return a JSON object with this exact structure:
{
  "summary": "A concise 3-4 sentence overview of overall player sentiment and what kind of game this appears to be",
  "strengths": [
    {"point": "description of a strength", "mentionRate": <integer 0-100, % of reviews mentioning this>}
  ],
  "weaknesses": [
    {"point": "description of a weakness", "mentionRate": <integer 0-100, % of reviews mentioning this>}
  ],
  "sentimentScore": <integer 0-100>,
  "sentimentBreakdown": {
    "ratingDistribution": {
      "score": <integer 0-100, based on the weighted average of star ratings: 1★=0, 2★=25, 3★=50, 4★=75, 5★=100>,
      "reasoning": "1-2 sentences explaining the rating distribution pattern, e.g. 'X% of reviews are 4-5 stars, indicating generally positive ratings'"
    },
    "textSentiment": {
      "score": <integer 0-100, based on the actual tone and language used in review text, independent of star rating>,
      "reasoning": "1-2 sentences on what the text reveals, e.g. 'Despite high ratings, many reviews express frustration about monetization'"
    },
    "issueSeverity": {
      "score": <integer 0-100, higher=less severe issues. Based on how critical/game-breaking the reported issues are>,
      "reasoning": "1-2 sentences on issue severity, e.g. 'Major complaints are cosmetic; no widespread crashes or data loss reported'"
    },
    "trendMomentum": {
      "score": <integer 0-100, based on whether recent reviews are more positive or negative than older ones>,
      "reasoning": "1-2 sentences on trend direction, e.g. 'Recent reviews show improvement after the latest update addressed key complaints'"
    },
    "formula": "A clear 1-sentence explanation: 'Final score X = (ratingDistribution×30% + textSentiment×35% + issueSeverity×20% + trendMomentum×15%)'"
  },
  "recentTrend": "A 3-4 sentence description of how player sentiment has changed over time based on the review dates. Note any recent improvements or deterioration",
  "topics": {
    "gameplay": <integer 0-100, how much players discuss core gameplay mechanics>,
    "graphics": <integer 0-100, how much players discuss visuals/art style>,
    "story": <integer 0-100, how much players discuss narrative/story>,
    "monetization": <integer 0-100, how much players discuss pricing/IAP/gacha>,
    "performance": <integer 0-100, how much players discuss bugs/crashes/optimization>,
    "community": <integer 0-100, how much players discuss social features/multiplayer/community>
  }
}

IMPORTANT rules:
- sentimentScore MUST equal the weighted result of sentimentBreakdown: ratingDistribution×0.30 + textSentiment×0.35 + issueSeverity×0.20 + trendMomentum×0.15, rounded to nearest integer.
- Each breakdown score must have concrete reasoning referencing actual review content.
- For strengths and weaknesses: include ONLY key points actually mentioned. Do NOT pad to a fixed number.
- mentionRate must be an integer representing the estimated % of analyzed reviews that mention this specific point.
- Sort each list by mentionRate descending (most mentioned first).
- Be specific and actionable (e.g. "Satisfying combat combo system" not just "Good gameplay").`;
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
    const prompt = buildAnalysisPrompt(gameName, reviews);

    const model = getModel();
    const promptTokenEstimate = Math.ceil(prompt.length / 3);
    console.log(`[AI Analysis] ${gameName}: sending ${reviews.length} reviews to LLM (model=${model}, ~${promptTokenEstimate} tokens)`);

    let content: string;
    try {
      const response = await callLLM(SYSTEM_PROMPT, prompt, 16_384);
      content = response.content;
      console.log(`[AI Analysis] ${gameName}: LLM responded (${response.inputTokens ?? "?"}in/${response.outputTokens ?? "?"}out tokens)`);
    } catch (llmErr: unknown) {
      const status = (llmErr as { status?: number }).status;
      const body = (llmErr as { error?: unknown }).error;
      console.error(`[AI Analysis] LLM error (status ${status}):`, JSON.stringify(body ?? llmErr));
      throw new Error(`LLM request failed (${status ?? "unknown"})`);
    }

    let cleaned = content.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    }

    const analysis = JSON.parse(cleaned);

    const breakdown = parseSentimentBreakdown(analysis.sentimentBreakdown);

    const result: AIAnalysisResult = {
      appId,
      gameName,
      iconUrl: opts?.iconUrl ?? null,
      source: opts?.source ?? "database",
      summary: analysis.summary ?? "No summary available",
      strengths: parseFeedbackItems(analysis.strengths),
      weaknesses: parseFeedbackItems(analysis.weaknesses),
      sentimentScore: typeof analysis.sentimentScore === "number" ? analysis.sentimentScore : 50,
      sentimentBreakdown: breakdown ?? undefined,
      topics: analysis.topics ?? {},
      recentTrend: typeof analysis.recentTrend === "string" ? analysis.recentTrend : "",
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
