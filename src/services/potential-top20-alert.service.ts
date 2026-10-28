import { prismaApp } from "../utils/prisma-app";
import { toPostgresIntAppId } from "../utils/pg-int-app-id";
import { logDiag, logDiagError } from "../utils/process-diagnostics";
import type { AppRankRow } from "../utils/app-rank";
import { rankingService } from "./ranking.service";
import { aiAnalysisService } from "./ai-analysis.service";
import { getLatestAnalysisForApp } from "./ai-analysis-store";
import { knownGame } from "./radar-known";
import { canDeliver, canSendAsBot, seatalkConfig } from "./seatalk/config";
import { deliver } from "./seatalk/client";
import type { AIAnalysisResult, PotentialScoreResult, PotentialSegment } from "../types";
import {
  POTENTIAL_ALERT_BOARDS,
  POTENTIAL_TOP20_DAYS,
  POTENTIAL_TOP20_LIMIT,
  POTENTIAL_TOP20_PLATFORM,
  formatPotentialAlertMessages,
  formatStaleMessage,
  messageHeader,
  type PotentialAlertBoardId,
  type PotentialAlertGame,
  type PotentialTop20Entry,
} from "./potential-top20-message";

export {
  POTENTIAL_ALERT_BOARDS,
  POTENTIAL_TOP20_DAYS,
  POTENTIAL_TOP20_LIMIT,
  POTENTIAL_TOP20_PLATFORM,
  formatPotentialAlertMessages,
};
export type { PotentialAlertBoardId, PotentialAlertGame, PotentialTop20Entry };

export interface PotentialTop20AlertResult {
  date: string;
  baseline: boolean;
  skipped: boolean;
  skipReason?: string;
  stale: boolean;
  newCount: number;
  analyzedCount: number;
  sent: boolean;
  dryRun: boolean;
  messages: string[];
  games: PotentialAlertGame[];
}

const DAY_MS = 86_400_000;

function envInt(name: string, fallback: number): number {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Game vắng top 20 ít nhất chừng này ngày thì vào lại được tính là game mới. */
export function alertLookbackDays(): number {
  return Math.max(1, envInt("POTENTIAL_ALERT_LOOKBACK_DAYS", 60));
}

/** Phân tích AI cũ hơn chừng này ngày thì chạy lại khi game được báo. */
function reanalyzeDays(): number {
  return envInt("POTENTIAL_ALERT_REANALYZE_DAYS", 30);
}

/** Số game tối đa chạy AI mỗi ngày. */
function aiMax(): number {
  return envInt("POTENTIAL_ALERT_AI_MAX", 15);
}

function calendarDateIct(now = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return new Date(`${y}-${m}-${d}T00:00:00.000Z`);
}

export function formatIctDate(date = calendarDateIct()): string {
  return date.toISOString().slice(0, 10);
}

export function sortValue(row: PotentialScoreResult, sort: "momentum" | "composite"): number {
  if (sort === "momentum") {
    return row.momentumScore ?? row.audienceGrowthAbsolute ?? Number.NEGATIVE_INFINITY;
  }
  return row.compositeScore;
}

export function storedScore(row: PotentialScoreResult, sort: "momentum" | "composite"): number {
  const v = sortValue(row, sort);
  return Number.isFinite(v) ? v : 0;
}

function takeTop20(
  board: PotentialAlertBoardId,
  scores: PotentialScoreResult[],
  sort: "momentum" | "composite",
): PotentialTop20Entry[] {
  const sorted = [...scores].sort((a, b) => {
    const diff = sortValue(b, sort) - sortValue(a, sort);
    if (diff !== 0) return diff;
    return a.appId - b.appId;
  });
  return sorted.slice(0, POTENTIAL_TOP20_LIMIT).map((row, i) => ({
    board,
    rank: i + 1,
    appId: row.appId,
    title: (row.title ?? "").trim() || `App #${row.appId}`,
    score: storedScore(row, sort),
  }));
}

function buildBoards(bySegment: Record<PotentialSegment, PotentialScoreResult[]>): PotentialTop20Entry[] {
  const out: PotentialTop20Entry[] = [];
  for (const board of POTENTIAL_ALERT_BOARDS) {
    out.push(...takeTop20(board.id, bySegment[board.segment], board.sort));
  }
  return out;
}

export async function computePotentialTop20Boards(): Promise<PotentialTop20Entry[]> {
  const [reserve, launched] = await Promise.all([
    rankingService.calculatePotentialScores(POTENTIAL_TOP20_DAYS, POTENTIAL_TOP20_PLATFORM, "reserve"),
    rankingService.calculatePotentialScores(POTENTIAL_TOP20_DAYS, POTENTIAL_TOP20_PLATFORM, "launched"),
  ]);
  return buildBoards({ reserve, launched });
}

/** Top 20 4 bảng như cron chạy vào ngày `asOfIso` — dựng lại lịch sử (backfill). */
export async function computePotentialTop20BoardsAsOf(asOfIso: string, rows: AppRankRow[]): Promise<PotentialTop20Entry[]> {
  const reserve = await rankingService.calculatePotentialScoresAsOf(
    asOfIso,
    POTENTIAL_TOP20_DAYS,
    POTENTIAL_TOP20_PLATFORM,
    "reserve",
    rows,
  );
  const launched = await rankingService.calculatePotentialScoresAsOf(
    asOfIso,
    POTENTIAL_TOP20_DAYS,
    POTENTIAL_TOP20_PLATFORM,
    "launched",
    rows,
  );
  return buildBoards({ reserve, launched });
}

async function resolveBootstrapUserId(): Promise<string | null> {
  const email = process.env.ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase();
  if (!email) return null;
  const user = await prismaApp.user.findUnique({
    where: { email },
    select: { id: true },
  });
  return user?.id ?? null;
}

async function previousSnapshotDate(today: Date): Promise<Date | null> {
  const row = await prismaApp.potentialBoardDay.findFirst({
    where: { date: { lt: today } },
    orderBy: { date: "desc" },
    select: { date: true },
  });
  return row?.date ?? null;
}

async function loadSnapshot(date: Date): Promise<PotentialTop20Entry[]> {
  const rows = await prismaApp.potentialBoardDay.findMany({
    where: { date },
    orderBy: [{ board: "asc" }, { rank: "asc" }],
  });
  return rows.map((r) => ({
    board: r.board as PotentialAlertBoardId,
    rank: r.rank,
    appId: r.appId,
    title: r.title,
    score: r.score,
  }));
}

export async function saveSnapshot(date: Date, entries: PotentialTop20Entry[]): Promise<void> {
  const data = entries.map((e) => ({
    date,
    board: e.board,
    rank: e.rank,
    appId: toPostgresIntAppId(e.appId),
    title: e.title.slice(0, 500),
    score: e.score,
  }));
  await prismaApp.potentialBoardDay.deleteMany({ where: { date } });
  if (data.length > 0) {
    await prismaApp.potentialBoardDay.createMany({ data });
  }
}

/** Cùng game, cùng hạng, cùng điểm ở cả 4 bảng — dấu hiệu dữ liệu chưa cập nhật. */
function sameBoards(a: PotentialTop20Entry[], b: PotentialTop20Entry[]): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  const key = (e: PotentialTop20Entry) => `${e.board}|${e.rank}|${toPostgresIntAppId(e.appId)}|${Math.round(e.score * 10)}`;
  const prev = new Set(b.map(key));
  return a.every((e) => prev.has(key(e)));
}

/** Game có trong top 20 hôm nay nhưng không có ở bảng nào trong `lookback` ngày trước đó. */
async function detectNewGames(today: Date, entries: PotentialTop20Entry[], lookback: number): Promise<PotentialAlertGame[]> {
  const ids = [...new Set(entries.map((e) => toPostgresIntAppId(e.appId)))];
  if (ids.length === 0) return [];
  const since = new Date(today.getTime() - lookback * DAY_MS);
  const recent = await prismaApp.potentialBoardDay.findMany({
    where: { date: { gte: since, lt: today }, appId: { in: ids } },
    select: { appId: true },
    distinct: ["appId"],
  });
  const seen = new Set(recent.map((r) => r.appId));
  const fresh = ids.filter((id) => !seen.has(id));
  if (fresh.length === 0) return [];

  const older = await prismaApp.potentialBoardDay.groupBy({
    by: ["appId"],
    where: { date: { lt: since }, appId: { in: fresh } },
    _max: { date: true },
  });
  const lastSeen = new Map(older.map((o) => [o.appId, o._max.date ? o._max.date.toISOString().slice(0, 10) : null]));

  const games: PotentialAlertGame[] = [];
  for (const id of fresh) {
    const mine = entries.filter((e) => toPostgresIntAppId(e.appId) === id);
    const boardOrder = (b: PotentialAlertBoardId) => POTENTIAL_ALERT_BOARDS.findIndex((x) => x.id === b);
    mine.sort((x, y) => boardOrder(x.board) - boardOrder(y.board) || x.rank - y.rank);
    const seenBefore = lastSeen.get(id) ?? null;
    games.push({
      appId: mine[0]!.appId,
      title: mine[0]!.title,
      titleEn: null,
      boards: mine.map((e) => ({ board: e.board, rank: e.rank, score: e.score })),
      firstEver: !lastSeen.has(id),
      lastSeen: seenBefore,
      analysisId: null,
      analysisScore: null,
      analyzedAt: null,
    });
  }
  return games.sort((a, b) => Math.min(...a.boards.map((x) => x.rank)) - Math.min(...b.boards.map((x) => x.rank)));
}

async function englishTitle(appId: number): Promise<string | null> {
  const known = knownGame(appId)?.titleEn?.trim();
  if (known) return known;
  const row = await prismaApp.radarRecapRow.findFirst({
    where: { appId: toPostgresIntAppId(appId), titleEn: { not: null } },
    orderBy: { date: "desc" },
    select: { titleEn: true },
  });
  return row?.titleEn?.trim() || null;
}

function analysisScore(a: AIAnalysisResult): number | null {
  const v = a.rubric?.aggregate?.weightedScore ?? a.sentimentScore ?? null;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function isFresh(a: AIAnalysisResult | null, maxAgeDays: number): boolean {
  if (!a) return false;
  const t = Date.parse(a.analyzedAt);
  return Number.isFinite(t) && Date.now() - t <= maxAgeDays * DAY_MS;
}

/** Chạy AI cho game mới chưa có phân tích (hoặc phân tích quá cũ), lần lượt theo hạng. */
async function ensureAnalyses(games: PotentialAlertGame[]): Promise<number> {
  if (games.length === 0) return 0;
  const userId = await resolveBootstrapUserId();
  if (!userId) {
    console.warn("[top20-alert] ADMIN_BOOTSTRAP_EMAIL user not found — skip auto AI (game links only)");
    return 0;
  }
  const cap = aiMax();
  const maxAge = reanalyzeDays();
  let analyzed = 0;
  for (const g of games) {
    if (analyzed >= cap) break;
    try {
      if (isFresh(await getLatestAnalysisForApp(g.appId), maxAge)) {
        console.log(`[top20-alert] skip AI appId=${g.appId} (analysis < ${maxAge} days)`);
        continue;
      }
      console.log(`[top20-alert] AI analyze appId=${g.appId}…`);
      await aiAnalysisService.analyzeGameReviews(userId, g.appId, { mode: "all" });
      analyzed += 1;
      console.log(`[top20-alert] AI done appId=${g.appId}`);
    } catch (err) {
      console.warn(`[top20-alert] AI failed appId=${g.appId}:`, err instanceof Error ? err.message : err);
      logDiagError("potential-top20-ai-failed", err, { appId: g.appId });
    }
  }
  return analyzed;
}

async function attachDetails(games: PotentialAlertGame[]): Promise<PotentialAlertGame[]> {
  const out: PotentialAlertGame[] = [];
  for (const g of games) {
    let next = { ...g, titleEn: await englishTitle(g.appId).catch(() => null) };
    try {
      const latest = await getLatestAnalysisForApp(g.appId);
      if (latest?.analysisId) {
        next = { ...next, analysisId: latest.analysisId, analysisScore: analysisScore(latest), analyzedAt: latest.analyzedAt };
      }
    } catch (err) {
      console.warn(`[top20-alert] lookup analysis failed for ${g.appId}:`, err instanceof Error ? err.message : err);
    }
    out.push(next);
  }
  return out;
}

const TERMINAL_STATUSES = new Set(["completed", "baseline"]);

async function claimRun(today: Date): Promise<{ skipped: boolean; reason?: string }> {
  const existing = await prismaApp.potentialAlertRun.findUnique({ where: { date: today } });
  if (existing && TERMINAL_STATUSES.has(existing.status)) {
    return { skipped: true, reason: `already ${existing.status}` };
  }
  if (!existing) {
    await prismaApp.potentialAlertRun.create({ data: { date: today, status: "started" } });
  } else {
    await prismaApp.potentialAlertRun.update({ where: { date: today }, data: { status: "started" } });
  }
  return { skipped: false };
}

async function finishRun(
  today: Date,
  status: string,
  fields: { newCount: number; analyzedCount: number; payload: Record<string, unknown> },
): Promise<void> {
  await prismaApp.potentialAlertRun.update({
    where: { date: today },
    data: {
      status,
      newCount: fields.newCount,
      analyzedCount: fields.analyzedCount,
      payload: fields.payload as object,
    },
  });
}

async function previousRunWasStale(today: Date): Promise<boolean> {
  const prev = await prismaApp.potentialAlertRun.findFirst({
    where: { date: { lt: today } },
    orderBy: { date: "desc" },
    select: { status: true },
  });
  return prev?.status === "stale";
}

async function sendMessages(messages: string[]): Promise<boolean> {
  const cfg = seatalkConfig();
  if (!canDeliver(cfg)) {
    console.log(
      "[top20-alert] SeaTalk skipped: set SEATALK_ENABLED=true plus SEATALK_DAILY_GROUP_ID (bot) or SEATALK_WEBHOOK_URL",
    );
    return false;
  }
  const groupId = canSendAsBot(cfg) ? cfg.dailyGroupId : null;
  for (const content of messages) {
    await deliver({ groupId, content });
  }
  console.log(`[top20-alert] SeaTalk sent ${messages.length} message(s)`);
  return true;
}

function emptyResult(dateLabel: string, dryRun: boolean, extra: Partial<PotentialTop20AlertResult>): PotentialTop20AlertResult {
  return {
    date: dateLabel,
    baseline: false,
    skipped: false,
    stale: false,
    newCount: 0,
    analyzedCount: 0,
    sent: false,
    dryRun,
    messages: [],
    games: [],
    ...extra,
  };
}

/**
 * Alert hằng ngày: game mới vào top 20 của 4 bảng Potential (14 ngày, combined).
 * Game mới = lần đầu vào top 20 hoặc vắng top 20 (mọi bảng) từ `POTENTIAL_ALERT_LOOKBACK_DAYS` ngày.
 */
export async function runPotentialTop20Alert(opts?: { dryRun?: boolean }): Promise<PotentialTop20AlertResult> {
  const dryRun = opts?.dryRun === true;
  const today = calendarDateIct();
  const dateLabel = formatIctDate(today);
  const lookback = alertLookbackDays();
  const cfg = seatalkConfig();

  console.log(`[top20-alert] start date=${dateLabel} lookback=${lookback}d dryRun=${dryRun}`);
  logDiag("potential-top20-start", { date: dateLabel, dryRun, lookback });

  if (!dryRun) {
    const claim = await claimRun(today);
    if (claim.skipped) {
      console.log(`[top20-alert] skip: ${claim.reason}`);
      return emptyResult(dateLabel, dryRun, { skipped: true, skipReason: claim.reason });
    }
  }

  try {
    const todayEntries = await computePotentialTop20Boards();
    const prevDate = await previousSnapshotDate(today);

    if (!prevDate) {
      const messages = [`${messageHeader(dateLabel, lookback)}\n\nĐã ghi baseline top 20. Alert game mới bắt đầu từ lần chạy sau.`];
      let sent = false;
      if (!dryRun) {
        await saveSnapshot(today, todayEntries);
        sent = await sendMessages(messages).catch(() => false);
        await finishRun(today, "baseline", { newCount: 0, analyzedCount: 0, payload: { baseline: true, sent, messages } });
      }
      return emptyResult(dateLabel, dryRun, { baseline: true, sent, messages });
    }

    const prevIso = formatIctDate(prevDate);
    if (sameBoards(todayEntries, await loadSnapshot(prevDate))) {
      console.warn(`[top20-alert] stale: boards identical to ${prevIso}`);
      const warnAgain = !(await previousRunWasStale(today));
      const messages = warnAgain ? [formatStaleMessage(dateLabel, prevIso)] : [];
      let sent = false;
      if (!dryRun) {
        if (messages.length > 0) sent = await sendMessages(messages).catch(() => false);
        await finishRun(today, "stale", { newCount: 0, analyzedCount: 0, payload: { stale: true, prevDate: prevIso, sent, messages } });
      }
      return emptyResult(dateLabel, dryRun, { stale: true, sent, messages });
    }

    let games = await detectNewGames(today, todayEntries, lookback);
    let analyzedCount = 0;
    if (!dryRun) {
      await saveSnapshot(today, todayEntries);
      analyzedCount = await ensureAnalyses(games);
    }
    games = await attachDetails(games);
    const messages = formatPotentialAlertMessages({ dateLabel, games, publicUrl: cfg.publicUrl, lookbackDays: lookback });

    let sent = false;
    if (!dryRun) {
      sent = await sendMessages(messages);
      await finishRun(today, "completed", {
        newCount: games.length,
        analyzedCount,
        payload: { sent, prevDate: prevIso, lookbackDays: lookback, games, messages },
      });
    }

    console.log(`[top20-alert] done new=${games.length} analyzed=${analyzedCount} sent=${sent} dryRun=${dryRun}`);
    logDiag("potential-top20-done", { date: dateLabel, newCount: games.length, analyzedCount, sent, dryRun });
    return emptyResult(dateLabel, dryRun, { newCount: games.length, analyzedCount, sent, messages, games });
  } catch (err) {
    logDiagError("potential-top20-failed", err, { date: dateLabel });
    if (!dryRun) {
      await finishRun(today, "failed", {
        newCount: 0,
        analyzedCount: 0,
        payload: { error: err instanceof Error ? err.message : String(err) },
      }).catch(() => undefined);
    }
    throw err;
  }
}
