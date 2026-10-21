import { prismaApp } from "../utils/prisma-app";
import { toPostgresIntAppId } from "../utils/pg-int-app-id";
import { logDiag, logDiagError } from "../utils/process-diagnostics";
import { rankingService } from "./ranking.service";
import { aiAnalysisService } from "./ai-analysis.service";
import { getLatestAnalysisForApp } from "./ai-analysis-store";
import { canDeliver, canSendAsBot, seatalkConfig } from "./seatalk/config";
import { deliver } from "./seatalk/client";
import type { PotentialScoreResult, PotentialSegment } from "../types";
import {
  POTENTIAL_ALERT_BOARDS,
  POTENTIAL_TOP20_DAYS,
  POTENTIAL_TOP20_LIMIT,
  POTENTIAL_TOP20_PLATFORM,
  formatPotentialTop20Messages,
  messageHeader,
  type PotentialAlertBoardId,
  type PotentialTop20Entry,
  type PotentialTop20Newcomer,
} from "./potential-top20-message";

export {
  POTENTIAL_ALERT_BOARDS,
  POTENTIAL_TOP20_DAYS,
  POTENTIAL_TOP20_LIMIT,
  POTENTIAL_TOP20_PLATFORM,
  formatPotentialTop20Messages,
};
export type { PotentialAlertBoardId, PotentialTop20Entry, PotentialTop20Newcomer };

export interface PotentialTop20AlertResult {
  date: string;
  baseline: boolean;
  skipped: boolean;
  skipReason?: string;
  newCount: number;
  analyzedCount: number;
  sent: boolean;
  dryRun: boolean;
  messages: string[];
  newcomers: PotentialTop20Newcomer[];
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

function sortValue(row: PotentialScoreResult, sort: "momentum" | "composite"): number {
  if (sort === "momentum") {
    return row.momentumScore ?? row.audienceGrowthAbsolute ?? Number.NEGATIVE_INFINITY;
  }
  return row.compositeScore;
}

function storedScore(row: PotentialScoreResult, sort: "momentum" | "composite"): number {
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

export async function computePotentialTop20Boards(): Promise<PotentialTop20Entry[]> {
  const [reserve, launched] = await Promise.all([
    rankingService.calculatePotentialScores(POTENTIAL_TOP20_DAYS, POTENTIAL_TOP20_PLATFORM, "reserve"),
    rankingService.calculatePotentialScores(POTENTIAL_TOP20_DAYS, POTENTIAL_TOP20_PLATFORM, "launched"),
  ]);
  const bySegment: Record<PotentialSegment, PotentialScoreResult[]> = {
    reserve,
    launched,
  };
  const out: PotentialTop20Entry[] = [];
  for (const board of POTENTIAL_ALERT_BOARDS) {
    out.push(...takeTop20(board.id, bySegment[board.segment], board.sort));
  }
  return out;
}

function uniqueAppIds(newcomers: PotentialTop20Newcomer[]): number[] {
  const seen = new Set<number>();
  const ids: number[] = [];
  for (const board of POTENTIAL_ALERT_BOARDS) {
    const rows = newcomers.filter((n) => n.board === board.id).sort((a, b) => a.rank - b.rank);
    for (const row of rows) {
      if (seen.has(row.appId)) continue;
      seen.add(row.appId);
      ids.push(row.appId);
    }
  }
  return ids;
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

async function saveSnapshot(date: Date, entries: PotentialTop20Entry[]): Promise<void> {
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

async function markFirstEver(
  today: Date,
  newcomers: PotentialTop20Entry[],
): Promise<PotentialTop20Newcomer[]> {
  if (newcomers.length === 0) return [];
  const history = await prismaApp.potentialBoardDay.findMany({
    where: {
      date: { lt: today },
      OR: newcomers.map((n) => ({ board: n.board, appId: toPostgresIntAppId(n.appId) })),
    },
    select: { board: true, appId: true },
  });
  const seen = new Set(history.map((h) => `${h.board}:${h.appId}`));
  return newcomers.map((n) => ({
    ...n,
    firstEver: !seen.has(`${n.board}:${toPostgresIntAppId(n.appId)}`),
  }));
}

function diffNewcomers(
  todayEntries: PotentialTop20Entry[],
  prevEntries: PotentialTop20Entry[],
): PotentialTop20Entry[] {
  const prevByBoard = new Map<string, Set<number>>();
  for (const row of prevEntries) {
    const set = prevByBoard.get(row.board) ?? new Set<number>();
    set.add(row.appId);
    prevByBoard.set(row.board, set);
  }
  return todayEntries.filter((row) => !prevByBoard.get(row.board)?.has(row.appId));
}

const TERMINAL_STATUSES = new Set(["completed", "baseline"]);

async function claimRun(today: Date): Promise<{ skipped: boolean; reason?: string }> {
  const existing = await prismaApp.potentialAlertRun.findUnique({ where: { date: today } });
  if (existing && TERMINAL_STATUSES.has(existing.status)) {
    return { skipped: true, reason: `already ${existing.status}` };
  }
  if (!existing) {
    await prismaApp.potentialAlertRun.create({
      data: { date: today, status: "started" },
    });
  } else {
    await prismaApp.potentialAlertRun.update({
      where: { date: today },
      data: { status: "started" },
    });
  }
  return { skipped: false };
}

async function finishRun(
  today: Date,
  status: string,
  fields: {
    newCount: number;
    analyzedCount: number;
    payload: Record<string, unknown>;
  },
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

async function attachAnalysisIds(
  newcomers: PotentialTop20Newcomer[],
): Promise<PotentialTop20Newcomer[]> {
  const ids = uniqueAppIds(newcomers);
  const map = new Map<number, string>();
  for (const appId of ids) {
    try {
      const latest = await getLatestAnalysisForApp(appId);
      if (latest?.analysisId) map.set(appId, latest.analysisId);
    } catch (err) {
      console.warn(
        `[top20-alert] lookup analysis failed for ${appId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return newcomers.map((n) => ({ ...n, analysisId: map.get(n.appId) ?? null }));
}

async function runAiForApps(appIds: number[]): Promise<number> {
  if (appIds.length === 0) return 0;
  const userId = await resolveBootstrapUserId();
  if (!userId) {
    console.warn(
      "[top20-alert] ADMIN_BOOTSTRAP_EMAIL user not found — skip auto AI (game links only)",
    );
    return 0;
  }

  let analyzed = 0;
  for (const appId of appIds) {
    try {
      const existing = await getLatestAnalysisForApp(appId);
      if (existing) {
        console.log(`[top20-alert] skip AI appId=${appId} (already has analysis)`);
        continue;
      }
      console.log(`[top20-alert] AI analyze appId=${appId}…`);
      await aiAnalysisService.analyzeGameReviews(userId, appId, { mode: "all" });
      analyzed += 1;
      console.log(`[top20-alert] AI done appId=${appId}`);
    } catch (err) {
      console.warn(
        `[top20-alert] AI failed appId=${appId}:`,
        err instanceof Error ? err.message : err,
      );
      logDiagError("potential-top20-ai-failed", err, { appId });
    }
  }
  return analyzed;
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

export async function runPotentialTop20Alert(opts?: {
  dryRun?: boolean;
}): Promise<PotentialTop20AlertResult> {
  const dryRun = opts?.dryRun === true;
  const today = calendarDateIct();
  const dateLabel = formatIctDate(today);
  const cfg = seatalkConfig();

  console.log(`[top20-alert] start date=${dateLabel} dryRun=${dryRun}`);
  logDiag("potential-top20-start", { date: dateLabel, dryRun });

  if (!dryRun) {
    const claim = await claimRun(today);
    if (claim.skipped) {
      console.log(`[top20-alert] skip: ${claim.reason}`);
      return {
        date: dateLabel,
        baseline: false,
        skipped: true,
        skipReason: claim.reason,
        newCount: 0,
        analyzedCount: 0,
        sent: false,
        dryRun,
        messages: [],
        newcomers: [],
      };
    }
  }

  const todayEntries = await computePotentialTop20Boards();
  const prevDate = await previousSnapshotDate(today);

  if (!prevDate) {
    const messages = [
      `${messageHeader(dateLabel)}\n\nĐã ghi baseline top 20. Alert game mới bắt đầu từ ngày mai.`,
    ];
    let sent = false;
    if (!dryRun) {
      await saveSnapshot(today, todayEntries);
      try {
        sent = await sendMessages(messages);
      } catch (err) {
        console.warn("[top20-alert] baseline SeaTalk failed:", err instanceof Error ? err.message : err);
        logDiagError("potential-top20-seatalk-failed", err, { date: dateLabel, baseline: true });
      }
      await finishRun(today, "baseline", {
        newCount: 0,
        analyzedCount: 0,
        payload: { baseline: true, sent, messages },
      });
    }
    console.log(`[top20-alert] baseline recorded (${todayEntries.length} rows)`);
    return {
      date: dateLabel,
      baseline: true,
      skipped: false,
      newCount: 0,
      analyzedCount: 0,
      sent,
      dryRun,
      messages,
      newcomers: [],
    };
  }

  const prevEntries = await loadSnapshot(prevDate);
  const entered = diffNewcomers(todayEntries, prevEntries);
  let newcomers = await markFirstEver(today, entered);
  let analyzedCount = 0;

  if (!dryRun) {
    await saveSnapshot(today, todayEntries);
    analyzedCount = await runAiForApps(uniqueAppIds(newcomers));
  }

  newcomers = await attachAnalysisIds(newcomers);
  const messages = formatPotentialTop20Messages({
    dateLabel,
    newcomers,
    publicUrl: cfg.publicUrl,
  });

  let sent = false;
  if (!dryRun) {
    try {
      sent = await sendMessages(messages);
      await finishRun(today, "completed", {
        newCount: newcomers.length,
        analyzedCount,
        payload: {
          sent,
          prevDate: formatIctDate(prevDate),
          newcomers,
          messages,
        },
      });
    } catch (err) {
      logDiagError("potential-top20-seatalk-failed", err, { date: dateLabel });
      await finishRun(today, "failed", {
        newCount: newcomers.length,
        analyzedCount,
        payload: {
          sent: false,
          error: err instanceof Error ? err.message : String(err),
          newcomers,
          messages,
        },
      });
      throw err;
    }
  }

  console.log(
    `[top20-alert] done new=${newcomers.length} analyzed=${analyzedCount} sent=${sent} dryRun=${dryRun}`,
  );
  logDiag("potential-top20-done", {
    date: dateLabel,
    newCount: newcomers.length,
    analyzedCount,
    sent,
    dryRun,
  });

  return {
    date: dateLabel,
    baseline: false,
    skipped: false,
    newCount: newcomers.length,
    analyzedCount,
    sent,
    dryRun,
    messages,
    newcomers,
  };
}
