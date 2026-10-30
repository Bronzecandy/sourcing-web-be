import fs from "fs";
import path from "path";
import { prismaApp } from "../utils/prisma-app";
import { toPostgresIntAppId } from "../utils/pg-int-app-id";
import { logDiag, logDiagError } from "../utils/process-diagnostics";
import { runWithConcurrency } from "../utils/run-with-concurrency";
import { getLatestAnalysisForApp } from "./ai-analysis-store";
import { canDeliver, canSendAsBot, seatalkConfig } from "./seatalk/config";
import { deliver, sendGroupFile } from "./seatalk/client";
import { computeRadarBoards, finalizeNewLaunch, type RadarBoardEntry } from "./radar-boards";
import { researchRadarGame } from "./radar-research";
import { EMPTY_FLAGS, extractRadarFacts, mergeSchedule } from "./radar-decide";
import { adjustmentText, applyRadarRules, matchPublisher } from "./radar-rules";
import { formatViDate, ictIsoDate, playableFrom, resolveSchedule, scheduleSignature } from "./radar-schedule";
import { loadRadarSnapshotFacts, radarScheduleAsOf, saveRadarSnapshot } from "./radar-watch.service";
import { loadInternalTests, testingThisWeek } from "./radar-internal-tests";
import { knownGame } from "./radar-known";
import { buildRadarSummary, buildSeatalkMessages, uniqueGames, withDigest } from "./radar-copy";
import { radarDocxBuffer, radarXlsxBuffer } from "./radar-export";
import {
  needsScreening,
  type RadarCarryOver,
  type RadarDecision,
  type RadarGameFacts,
  type RadarInternalTest,
  type RadarMetrics,
  type RadarRowPayload,
  type RadarSchedule,
  type RadarSummary,
} from "./radar-types";

export interface RadarRecapView {
  date: string;
  periodCode: string;
  status: string;
  summary: RadarSummary | null;
  rows: RadarRowPayload[];
}

export interface RunRadarOptions {
  /** Chạy lại dù kỳ hôm nay đã completed. */
  force?: boolean;
  /** Không ghi DB, không gửi SeaTalk — trả view để xem/xuất file. */
  dryRun?: boolean;
  /** YYYY-MM-DD, mặc định hôm nay (ICT). */
  date?: string;
  skipScreening?: boolean;
  publish?: boolean;
}

export interface RunRadarResult {
  skipped: boolean;
  reason?: string;
  date: string;
  rows: number;
  view?: RadarRecapView;
}

interface BaselineHit {
  appId: number;
  nextAction: string;
  date: string;
}

interface AppWork {
  appId: number;
  title: string;
  entries: RadarBoardEntry[];
  score: number;
  metrics: RadarMetrics;
}

interface AppOutcome {
  decision: RadarDecision;
  metrics: RadarMetrics;
}

const CARRY_OVER_NOTE = "ALERT: chưa đọc được trang TapTap kỳ này — giữ trạng thái kỳ trước";
const ANALYZE_CONCURRENCY = 3;
const FETCH_CONCURRENCY = 2;
/** Giãn request TapTap khi phải đọc trực tiếp (không có snapshot trong ngày). */
const FETCH_GAP_MS = 350;

function dbDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function isoOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dateLabel(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${Number(d)}/${Number(m)}/${y}`;
}

function periodCodeOf(iso: string): string {
  return iso.slice(5, 7) + iso.slice(8, 10);
}

/** 0 = Chủ nhật … 6 = Thứ Bảy (mặc định 1 = Thứ Hai). */
export function radarWeekday(): number {
  const n = Number(process.env.RADAR_RECAP_WEEKDAY ?? "1");
  return Number.isInteger(n) && n >= 0 && n <= 6 ? n : 1;
}

function weekdayOf(iso: string): number {
  return dbDate(iso).getUTCDay();
}

/** Ngày bắt đầu kỳ tuần chứa `iso`: ngày RADAR_RECAP_WEEKDAY gần nhất không sau `iso`. */
export function periodWindowStart(iso: string): string {
  const back = (weekdayOf(iso) - radarWeekday() + 7) % 7;
  return isoOf(new Date(dbDate(iso).getTime() - back * 86_400_000));
}

/**
 * Cron hằng ngày gọi: chạy đúng ngày cấu hình, hoặc chạy bù khi kỳ tuần này đã thử nhưng
 * lỗi/dữ liệu trùng (chưa có kỳ completed).
 */
export async function shouldRunWeeklyRadar(todayIso = ictIsoDate()): Promise<boolean> {
  const start = dbDate(periodWindowStart(todayIso));
  const runs = await prismaApp.radarRecapRun.findMany({
    where: { date: { gte: start, lte: dbDate(todayIso) } },
    select: { status: true, date: true },
  });
  if (runs.some((r) => r.status === "completed")) return false;
  if (weekdayOf(todayIso) === radarWeekday()) return true;
  return runs.some((r) => isoOf(r.date) < todayIso);
}

function loadBaseline(): BaselineHit[] {
  const file = path.join(process.cwd(), "data", "radar", "baseline-1001.json");
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as BaselineHit[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowsFromDb(raw: Array<{ payload: unknown }>): RadarRowPayload[] {
  return raw.map((r) => r.payload as RadarRowPayload);
}

function radarReportUrl(dateIso: string): string {
  return `${seatalkConfig().publicUrl}/radar?date=${dateIso}`;
}

/** Kỳ Radar cho trang web: Executive Summary dựng lại từ dòng đã lưu nên áp cả cho kỳ cũ. */
export async function getRadarReport(dateIso?: string): Promise<RadarRecapView | null> {
  const view = await getRadarRecap(dateIso);
  if (!view?.summary || view.status !== "completed") return view;
  const prev = await previousRun(dbDate(view.date));
  return { ...view, summary: withDigest(view.summary, view.rows, prev?.rows ?? [], view.date, radarReportUrl(view.date)) };
}

export async function getRadarRecap(dateIso?: string): Promise<RadarRecapView | null> {
  const run = dateIso
    ? await prismaApp.radarRecapRun.findUnique({
        where: { date: dbDate(dateIso) },
        include: { rows: { orderBy: [{ board: "asc" }, { rank: "asc" }] } },
      })
    : await prismaApp.radarRecapRun.findFirst({
        where: { status: "completed" },
        orderBy: { date: "desc" },
        include: { rows: { orderBy: [{ board: "asc" }, { rank: "asc" }] } },
      });
  if (!run) return null;
  return {
    date: isoOf(run.date),
    periodCode: run.periodCode,
    status: run.status,
    summary: (run.summary as RadarSummary | null) ?? null,
    rows: rowsFromDb(run.rows),
  };
}

export interface RadarRunListItem {
  date: string;
  periodCode: string;
  /** completed | imported (báo cáo làm tay) | stale | failed | started */
  status: string;
  source: "tool" | "sheet";
  /** Tuần chứa kỳ (từ ngày RADAR_RECAP_WEEKDAY). */
  weekStart: string;
  weekEnd: string;
  games: number;
  actions: { testViable: number; monitor: number; ignore: number; drop: number; other: number };
  highPotential: number;
  /** Game High/Mid mới vào radar và có lịch mới — cùng số với Executive Summary trên web. */
  newGames: number;
  scheduleUpdates: number;
  hasDocx: boolean;
}

const LEGACY_DIR = path.join(process.cwd(), "data", "radar", "legacy");

function legacyDocx(summary: unknown): string | null {
  const name = (summary as { docx?: unknown } | null)?.docx;
  if (typeof name !== "string" || !name) return null;
  const file = path.join(LEGACY_DIR, path.basename(name));
  return fs.existsSync(file) ? file : null;
}

export async function listRadarRuns(limit = 60): Promise<RadarRunListItem[]> {
  const runs = await prismaApp.radarRecapRun.findMany({
    orderBy: { date: "desc" },
    take: limit,
    select: { date: true, periodCode: true, status: true, summary: true },
  });
  if (runs.length === 0) return [];
  const oldest = runs[runs.length - 1]!.date;
  const stats = await prismaApp.$queryRaw<
    Array<{
      date: Date;
      games: number;
      testViable: number;
      monitor: number;
      ignore: number;
      drop: number;
      high: number;
      newGames: number;
      scheduleUpdates: number;
    }>
  >`
    SELECT "date",
      count(DISTINCT "appId")::int AS "games",
      count(DISTINCT "appId") FILTER (WHERE "nextAction" LIKE 'Test Viable%')::int AS "testViable",
      count(DISTINCT "appId") FILTER (WHERE "nextAction" LIKE 'Monitor%')::int AS "monitor",
      count(DISTINCT "appId") FILTER (WHERE "nextAction" LIKE 'Temporary Ignore%')::int AS "ignore",
      count(DISTINCT "appId") FILTER (WHERE "nextAction" LIKE 'Drop%')::int AS "drop",
      count(DISTINCT "appId") FILTER (WHERE "nextAction" LIKE '%High Potential')::int AS "high",
      count(DISTINCT "appId") FILTER (
        WHERE "payload"->>'newThisPeriod' = 'true' AND "nextAction" ~ '(High|Mid|Medium) Potential$'
      )::int AS "newGames",
      count(DISTINCT "appId") FILTER (
        WHERE "payload"->>'scheduleChanged' = 'true' AND "nextAction" ~ '(High|Mid|Medium) Potential$'
      )::int AS "scheduleUpdates"
    FROM "RadarRecapRow"
    WHERE "date" >= ${oldest}
    GROUP BY "date"
  `;
  const byDate = new Map(stats.map((s) => [isoOf(s.date), s]));
  return runs.map((r) => {
    const date = isoOf(r.date);
    const s = byDate.get(date);
    const weekStart = periodWindowStart(date);
    const known = s ? s.testViable + s.monitor + s.ignore + s.drop : 0;
    const legacy = r.status === "imported";
    return {
      date,
      periodCode: r.periodCode,
      status: r.status,
      source: legacy ? "sheet" : "tool",
      weekStart,
      weekEnd: isoOf(new Date(dbDate(weekStart).getTime() + 6 * 86_400_000)),
      games: s?.games ?? 0,
      actions: {
        testViable: s?.testViable ?? 0,
        monitor: s?.monitor ?? 0,
        ignore: s?.ignore ?? 0,
        drop: s?.drop ?? 0,
        other: Math.max(0, (s?.games ?? 0) - known),
      },
      highPotential: s?.high ?? 0,
      newGames: s?.newGames ?? 0,
      scheduleUpdates: s?.scheduleUpdates ?? 0,
      hasDocx: legacy ? legacyDocx(r.summary) != null : r.status === "completed",
    };
  });
}

export async function radarFile(dateIso: string, kind: "docx" | "xlsx"): Promise<{ filename: string; body: Buffer } | null> {
  const view = await getRadarRecap(dateIso);
  if (!view?.summary) return null;
  const code = view.periodCode;
  if (view.status === "imported") {
    if (kind === "xlsx") {
      return { filename: `Game Radar Recap ${code}.xlsx`, body: await radarXlsxBuffer(code, view.rows) };
    }
    const file = legacyDocx(view.summary);
    return file ? { filename: path.basename(file), body: fs.readFileSync(file) } : null;
  }
  if (kind === "docx") {
    return {
      filename: `Executive Summary - Radar ${code}.docx`,
      body: await radarDocxBuffer(view.summary, view.rows, view.date),
    };
  }
  return {
    filename: `Game Radar Recap ${code}.xlsx`,
    body: await radarXlsxBuffer(code, view.rows),
  };
}

/** Kỳ trước = báo cáo tuần trước: lần chạy completed gần nhất trước ngày bắt đầu tuần của `today`. */
async function previousRun(today: Date): Promise<{ date: string; periodCode: string; rows: RadarRowPayload[] } | null> {
  const run = await prismaApp.radarRecapRun.findFirst({
    where: { date: { lt: dbDate(periodWindowStart(isoOf(today))) }, status: "completed" },
    orderBy: { date: "desc" },
    include: { rows: true },
  });
  if (!run) return null;
  return { date: isoOf(run.date), periodCode: run.periodCode, rows: rowsFromDb(run.rows) };
}

async function olderAction(appId: number, before: Date): Promise<{ action: string; date: string } | null> {
  const row = await prismaApp.radarRecapRow.findFirst({
    where: { appId: toPostgresIntAppId(appId), date: { lt: before } },
    orderBy: { date: "desc" },
    select: { nextAction: true, date: true },
  });
  return row ? { action: row.nextAction, date: isoOf(row.date) } : null;
}

async function screeningFor(appId: number, action: string, publicUrl: string): Promise<{ url: string | null; score: number | null }> {
  if (!needsScreening(action)) return { url: null, score: null };
  const latest = await getLatestAnalysisForApp(appId);
  if (!latest?.analysisId) return { url: null, score: null };
  const score = latest.rubric?.aggregate?.weightedScore ?? latest.sentimentScore ?? null;
  return { url: `${publicUrl}/ai-analysis/a/${latest.analysisId}`, score };
}

async function resolveBootstrapUserId(): Promise<string | null> {
  const email = process.env.ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase();
  if (!email) return null;
  const user = await prismaApp.user.findUnique({ where: { email }, select: { id: true } });
  return user?.id ?? null;
}

/** AI screening tuần tự cho game Monitor+ chưa có phân tích (giới hạn RADAR_SCREENING_MAX). */
async function ensureScreening(appIds: number[]): Promise<number> {
  const cap = Math.max(0, Number(process.env.RADAR_SCREENING_MAX ?? "15") || 0);
  if (cap === 0 || appIds.length === 0) return 0;
  const userId = await resolveBootstrapUserId();
  if (!userId) {
    console.warn("[radar] ADMIN_BOOTSTRAP_EMAIL user not found — skip AI screening");
    return 0;
  }
  const { aiAnalysisService } = await import("./ai-analysis.service");
  let done = 0;
  for (const appId of appIds) {
    if (done >= cap) break;
    try {
      if (await getLatestAnalysisForApp(appId)) continue;
      console.log(`[radar] AI screening appId=${appId}…`);
      await aiAnalysisService.analyzeGameReviews(userId, appId, { mode: "all" });
      done += 1;
    } catch (err) {
      console.warn(`[radar] AI screening failed appId=${appId}:`, err instanceof Error ? err.message : err);
      logDiagError("radar-screening", err, { appId });
    }
  }
  return done;
}

function groupApps(boards: RadarBoardEntry[]): AppWork[] {
  const byApp = new Map<number, AppWork>();
  for (const entry of boards) {
    const app = byApp.get(entry.appId);
    if (!app) {
      byApp.set(entry.appId, {
        appId: entry.appId,
        title: entry.title,
        entries: [entry],
        score: entry.score,
        metrics: { ...entry.metrics },
      });
      continue;
    }
    app.entries.push(entry);
    if (entry.score > app.score) {
      app.score = entry.score;
      app.metrics = { ...app.metrics, ...definedOnly(entry.metrics) };
    } else {
      app.metrics = { ...definedOnly(entry.metrics), ...definedOnly(app.metrics) } as RadarMetrics;
    }
  }
  return [...byApp.values()];
}

function definedOnly<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null)) as Partial<T>;
}

type BoardSlot = { board: string; rank: number; appId: number; score: number };

function isReserveSlot(slot: BoardSlot): boolean {
  return slot.board !== "new_launch";
}

/** Hạng + điểm trùng 100% kỳ trước → tool chưa cập nhật dữ liệu. */
function sameAsPrevious(current: BoardSlot[], prevRows: BoardSlot[]): boolean {
  if (prevRows.length === 0 || prevRows.length !== current.length) return false;
  const prev = new Map(prevRows.map((r) => [`${r.board}#${r.rank}`, r]));
  return current.every((e) => {
    const p = prev.get(`${e.board}#${e.rank}`);
    return p != null && p.appId === e.appId && Math.abs(p.score - e.score) < 0.05;
  });
}

function withScale(metrics: RadarMetrics, facts: RadarGameFacts | null): RadarMetrics {
  const reserve = facts?.reserveCount ?? metrics.reserveCount ?? null;
  const downloads = Math.max(facts?.downloadCount ?? 0, metrics.downloadCount ?? 0) || null;
  const useDownload = downloads != null && (reserve == null || downloads > reserve);
  return {
    ...metrics,
    reserveCount: reserve,
    downloadCount: downloads,
    scale: useDownload ? downloads : reserve,
    scaleKind: useDownload ? "download" : reserve != null ? "reserve" : null,
    rating: facts?.rating ?? metrics.rating,
    fansCount: facts?.fansCount ?? metrics.fansCount,
  };
}

function changeNote(prev: RadarSchedule | null, now: RadarSchedule): string {
  const when = formatViDate(now.date);
  switch (now.kind) {
    case "launched":
      return when ? `vừa ra mắt ${when}` : "vừa ra mắt";
    case "open_beta":
      return when ? `vừa mở open beta ${when}` : "vừa mở open beta";
    case "launch_date":
      if (/Open beta/.test(now.label)) return `vừa chốt ngày open beta ${when}`;
      return prev?.kind === "launch_date" ? `đổi ngày ra mắt sang ${when}` : `vừa chốt ngày ra mắt ${when}`;
    case "closed_beta":
      return `vừa công bố đợt test kín ${when}`;
    case "test_recruit":
      return when ? `vừa mở tuyển test (${when})` : "vừa mở tuyển test";
    case "test_running":
      return when ? `đang chạy đợt test kín từ ${when}` : "đang chạy đợt test kín";
    default:
      return now.label;
  }
}

/** Facts TapTap trong ngày: dùng snapshot của job watch nếu có, không thì đọc trang và lưu snapshot. */
async function loadFacts(appId: number, title: string, todayIso: string, dryRun: boolean): Promise<RadarGameFacts> {
  const cached = await loadRadarSnapshotFacts(todayIso, appId).catch(() => null);
  if (cached) return cached;
  await new Promise((r) => setTimeout(r, FETCH_GAP_MS));
  const facts = await researchRadarGame(appId, title);
  if (facts.fetched !== false && !dryRun) {
    await saveRadarSnapshot(todayIso, facts, resolveSchedule(facts, todayIso)).catch(() => undefined);
  }
  return facts;
}

async function decideApp(
  app: AppWork,
  facts: RadarGameFacts,
  ctx: {
    todayIso: string;
    prevRow: RadarRowPayload | null;
    prevAction: string | null;
    internal: RadarInternalTest | undefined;
  },
): Promise<AppOutcome> {
  const { todayIso, prevRow } = ctx;
  const known = knownGame(app.appId);
  const metrics = withScale(app.metrics, facts.fetched === false ? null : facts);
  const detected = resolveSchedule(facts, todayIso);
  const llm =
    facts.fetched === false
      ? null
      : await extractRadarFacts({
          facts,
          boards: [...new Set(app.entries.map((e) => e.board))],
          score: app.score,
          detected,
          previousAction: ctx.prevAction,
          todayIso,
        });

  if (!llm && prevRow) {
    const unsuitable = ctx.internal?.result === "unsuitable";
    const nextAction = unsuitable ? "Drop" : prevRow.nextAction;
    return {
      metrics,
      decision: {
        titleEn: prevRow.titleEn,
        insights: prevRow.insights,
        nextAction,
        reason: unsuitable ? "Đã test nội bộ, kết quả không phù hợp" : prevRow.reason,
        releaseLabel: prevRow.releaseLabel,
        playableNow: nextAction.startsWith("Test Viable"),
        genre: prevRow.genre,
        publisher: prevRow.publisher,
        toolAdjustments: "",
        tier: prevRow.tier ?? null,
        schedule: prevRow.schedule,
        flags: prevRow.flags,
        alerts: [CARRY_OVER_NOTE],
        videoUrl: prevRow.videoUrl ?? facts.videoUrl ?? null,
        carriedOver: true,
      },
    };
  }

  const schedule = mergeSchedule(detected, llm?.schedule ?? null, facts, todayIso);
  const flags = llm?.flags ?? { ...EMPTY_FLAGS, liveService: facts.online !== false };
  const publisher = matchPublisher(known?.publisher, llm?.publisher, facts.publisher, facts.developer);
  const genre = known?.genre || prevRow?.genre || llm?.genre || facts.tags.slice(0, 3).join(", ");
  const rule = applyRadarRules({
    score: app.score,
    metrics,
    flags,
    facts,
    playable: playableFrom(schedule, facts),
    topTierPublisher: Boolean(publisher?.topTier),
    internalUnsuitable: ctx.internal?.result === "unsuitable",
    genre,
    todayIso,
  });
  const alerts = llm ? rule.alerts : ["ALERT: chưa phân tích được trang TapTap kỳ này", ...rule.alerts];
  return {
    metrics,
    decision: {
      titleEn: known?.titleEn || prevRow?.titleEn || llm?.titleEn || "",
      insights: llm?.insights || prevRow?.insights || `${facts.title}: ${genre || "chưa research đủ kỳ này"}.`,
      nextAction: rule.nextAction,
      reason: rule.reason,
      releaseLabel: schedule.label,
      playableNow: rule.nextAction.startsWith("Test Viable"),
      genre,
      publisher:
        known?.publisher || publisher?.name || prevRow?.publisher || llm?.publisher || facts.publisher || facts.developer || "",
      toolAdjustments: "",
      tier: rule.tier,
      schedule,
      flags,
      alerts,
      videoUrl: known?.videoUrl || facts.videoUrl || null,
      carriedOver: false,
    },
  };
}

async function markRun(iso: string, data: { status: string; periodCode: string; summary?: object }): Promise<void> {
  await prismaApp.radarRecapRun.upsert({
    where: { date: dbDate(iso) },
    create: { date: dbDate(iso), ...data },
    update: data,
  });
}

async function notifyStale(todayIso: string, periodCode: string, prevCode: string): Promise<void> {
  const cfg = seatalkConfig();
  if (!canDeliver(cfg)) return;
  const groupId = canSendAsBot(cfg) ? cfg.dailyGroupId : null;
  await deliver({
    groupId,
    content:
      `**Game Radar Recap kỳ ${periodCode}**\n` +
      `Dữ liệu tool chưa cập nhật so với kỳ ${prevCode} (hạng và điểm trùng 100%), nên chưa xuất report kỳ này. ` +
      `Hệ thống sẽ thử lại ở lần chạy sau (${dateLabel(todayIso)}).`,
  });
}

export async function runRadarRecap(opts: RunRadarOptions = {}): Promise<RunRadarResult> {
  const todayIso = opts.date ?? ictIsoDate();
  const today = dbDate(todayIso);
  const periodCode = periodCodeOf(todayIso);
  const dryRun = opts.dryRun === true;

  if (!dryRun) {
    const existing = await prismaApp.radarRecapRun.findUnique({ where: { date: today } });
    if (existing?.status === "completed" && !opts.force) {
      console.log(`[radar] skip ${todayIso}: already completed`);
      return { skipped: true, reason: "already completed", date: todayIso, rows: 0 };
    }
    await markRun(todayIso, { status: "started", periodCode });
  }

  console.log(`[radar] start ${todayIso}${dryRun ? " (dry run)" : ""}`);
  logDiag("radar-recap-start", { date: todayIso, dryRun });
  const publicUrl = seatalkConfig().publicUrl;

  try {
    const candidates = await computeRadarBoards();
    const prev = await previousRun(today);
    const prevRows = prev?.rows ?? [];

    if (prev && sameAsPrevious(candidates.filter(isReserveSlot), prevRows.filter(isReserveSlot))) {
      console.warn(`[radar] stale data: same ranks/scores as ${prev.date}`);
      if (!dryRun) {
        const window = dbDate(periodWindowStart(todayIso));
        const alreadyWarned = await prismaApp.radarRecapRun.count({
          where: { date: { gte: window, lt: today }, status: "stale" },
        });
        await markRun(todayIso, { status: "stale", periodCode, summary: { stale: true, previousDate: prev.date } });
        if (alreadyWarned === 0) await notifyStale(todayIso, periodCode, prev.periodCode).catch(() => undefined);
      }
      return { skipped: true, reason: "stale", date: todayIso, rows: 0 };
    }

    const baseline = prev ? [] : loadBaseline();
    const baselineById = new Map(baseline.map((b) => [b.appId, b]));
    const prevByApp = new Map(uniqueGames(prevRows).map((r) => [r.appId, r]));
    const prevBoardIds = new Map<string, Set<number>>();
    for (const r of prevRows) {
      const set = prevBoardIds.get(r.board) ?? new Set<number>();
      set.add(r.appId);
      prevBoardIds.set(r.board, set);
    }

    const titles = new Map<number, string>();
    for (const c of candidates) if (!titles.has(c.appId)) titles.set(c.appId, c.title);
    const factsByApp = new Map<number, RadarGameFacts>();
    const loaded = await runWithConcurrency(
      [...titles].map(([appId, title]) => () => loadFacts(appId, title, todayIso, dryRun).catch(() => null)),
      FETCH_CONCURRENCY,
    );
    for (const facts of loaded) if (facts) factsByApp.set(facts.appId, facts);

    const boards = finalizeNewLaunch(candidates, factsByApp, todayIso);
    const apps = groupApps(boards);
    const internal = await loadInternalTests(apps.map((a) => a.appId), todayIso);
    const prevActions = new Map<number, { action: string; date: string } | null>();
    for (const app of apps) {
      const p = prevByApp.get(app.appId);
      if (p && prev) prevActions.set(app.appId, { action: p.nextAction, date: prev.date });
      else {
        const older = await olderAction(app.appId, today);
        const base = baselineById.get(app.appId);
        prevActions.set(app.appId, older ?? (base ? { action: base.nextAction, date: base.date } : null));
      }
    }

    const outcomes = await runWithConcurrency(
      apps.map((app) => async () => {
        try {
          const facts =
            factsByApp.get(app.appId) ?? (await loadFacts(app.appId, app.title, todayIso, dryRun));
          return await decideApp(app, facts, {
            todayIso,
            prevRow: prevByApp.get(app.appId) ?? null,
            prevAction: prevActions.get(app.appId)?.action ?? null,
            internal: internal.get(app.appId),
          });
        } catch (err) {
          logDiagError("radar-recap-app", err, { appId: app.appId });
          return null;
        }
      }),
      ANALYZE_CONCURRENCY,
    );
    const byApp = new Map<number, AppOutcome>();
    apps.forEach((app, i) => {
      const outcome = outcomes[i];
      if (outcome) byApp.set(app.appId, outcome);
    });

    if (!dryRun && !opts.skipScreening) {
      const pending = apps
        .filter((a) => byApp.has(a.appId) && needsScreening(byApp.get(a.appId)!.decision.nextAction))
        .sort((a, b) => b.score - a.score)
        .map((a) => a.appId);
      const analyzed = await ensureScreening(pending);
      if (analyzed > 0) console.log(`[radar] AI screening done for ${analyzed} game(s)`);
    }

    const rows: RadarRowPayload[] = [];
    const scheduleChange = new Map<number, { changed: boolean; note: string }>();
    for (const app of apps) {
      const outcome = byApp.get(app.appId);
      if (!outcome) continue;
      const { decision, metrics } = outcome;
      const prevRow = prevByApp.get(app.appId) ?? null;
      const baselineSchedule = prev
        ? ((await radarScheduleAsOf(app.appId, prev.date).catch(() => null)) ?? prevRow?.schedule ?? null)
        : null;
      const sigPrev = baselineSchedule ? scheduleSignature(baselineSchedule) : null;
      const sigNow = scheduleSignature(decision.schedule);
      const changed = !decision.carriedOver && sigPrev !== null && sigNow !== "" && sigNow !== sigPrev;
      scheduleChange.set(app.appId, {
        changed,
        note: changed && decision.schedule ? changeNote(baselineSchedule, decision.schedule) : "",
      });

      const screening = await screeningFor(app.appId, decision.nextAction, publicUrl);
      const prevAction = prevActions.get(app.appId) ?? null;
      for (const entry of app.entries) {
        const seenOnBoard = prev
          ? prevBoardIds.get(entry.board)?.has(app.appId) === true
          : baselineById.has(app.appId);
        const newThisPeriod = prev ? !prevByApp.has(app.appId) : !baselineById.has(app.appId);
        const change = scheduleChange.get(app.appId)!;
        rows.push({
          ...decision,
          toolAdjustments: adjustmentText({
            isNewOnBoard: !seenOnBoard,
            prevAction: prevAction?.action ?? null,
            prevDate: prevAction?.date ?? null,
            nextAction: decision.nextAction,
            reason: decision.reason,
            alerts: decision.alerts ?? [],
          }),
          board: entry.board,
          rank: entry.rank,
          appId: app.appId,
          title: app.title,
          score: entry.score,
          taptapUrl: `https://www.taptap.cn/app/${app.appId}?from=radar`,
          overviewUrl: `${publicUrl}/game/${app.appId}`,
          screeningUrl: screening.url,
          analysisScore: screening.score,
          firstInRecap: !seenOnBoard,
          newThisPeriod,
          previousAction: prevAction?.action ?? null,
          previousDate: prevAction?.date ?? null,
          metrics,
          scheduleChanged: change.changed,
          scheduleChangeNote: change.note,
          internalTest: internal.get(app.appId) ?? null,
        });
      }
      console.log(`[radar] ${app.appId} ${decision.nextAction}${decision.schedule?.label ? ` · ${decision.schedule.label}` : ""}`);
    }
    rows.sort((a, b) => a.board.localeCompare(b.board) || a.rank - b.rank);

    const currentIds = new Set(rows.map((r) => r.appId));
    const carryOver: RadarCarryOver[] = uniqueGames(prevRows)
      .filter((r) => r.nextAction.startsWith("Test Viable") && !currentIds.has(r.appId))
      .map((r) => ({
        appId: r.appId,
        title: r.title,
        titleEn: r.titleEn,
        nextAction: r.nextAction,
        previousDate: prev!.date,
        overviewUrl: r.overviewUrl,
      }));

    const summary = buildRadarSummary({
      todayIso,
      dateLabel: dateLabel(todayIso),
      periodCode,
      rows,
      prevRows,
      prevDate: prev?.date ?? null,
      prevPeriodCode: prev?.periodCode ?? null,
      carryOver,
      testingThisWeek: await testingThisWeek(todayIso),
      reportUrl: radarReportUrl(todayIso),
    });
    const view: RadarRecapView = { date: todayIso, periodCode, status: dryRun ? "dry-run" : "completed", summary, rows };

    if (dryRun) {
      console.log(`[radar] dry run ${todayIso} rows=${rows.length}`);
      return { skipped: false, date: todayIso, rows: rows.length, view };
    }

    await prismaApp.radarRecapRow.deleteMany({ where: { date: today } });
    if (rows.length > 0) {
      await prismaApp.radarRecapRow.createMany({
        data: rows.map((row) => ({
          date: today,
          board: row.board,
          rank: row.rank,
          appId: toPostgresIntAppId(row.appId),
          title: row.title.slice(0, 500),
          titleEn: row.titleEn.slice(0, 300) || null,
          score: row.score,
          nextAction: row.nextAction,
          insights: row.insights,
          adjustments: row.toolAdjustments,
          screening: row.screeningUrl
            ? `${row.analysisScore != null ? Math.round(row.analysisScore) : ""} — Xem chi tiết`
            : needsScreening(row.nextAction)
              ? "Chưa có — cần screening"
              : "—",
          payload: row as object,
        })),
      });
    }
    await markRun(todayIso, { status: "completed", periodCode, summary: summary as object });

    if (opts.publish !== false) {
      try {
        await publishRadarNotice(summary, rows, periodCode, todayIso);
      } catch (err) {
        console.warn("[radar] SeaTalk notice failed:", err instanceof Error ? err.message : err);
        logDiagError("radar-recap-notice", err, { date: todayIso });
      }
    }
    console.log(`[radar] done ${todayIso} rows=${rows.length}`);
    logDiag("radar-recap-done", { date: todayIso, rows: rows.length });
    return { skipped: false, date: todayIso, rows: rows.length, view };
  } catch (err) {
    if (!dryRun) {
      await markRun(todayIso, {
        status: "failed",
        periodCode,
        summary: { error: err instanceof Error ? err.message : String(err) },
      }).catch(() => undefined);
    }
    logDiagError("radar-recap-failed", err, { date: todayIso });
    throw err;
  }
}

export async function publishRadarNotice(
  summary: RadarSummary,
  rows: RadarRowPayload[],
  periodCode: string,
  dateIso: string,
): Promise<void> {
  const cfg = seatalkConfig();
  if (!canDeliver(cfg)) {
    console.warn("[radar] SeaTalk is off, skip notice");
    return;
  }
  const groupId = canSendAsBot(cfg) ? cfg.dailyGroupId : null;
  for (const content of buildSeatalkMessages(summary.copyText)) {
    await deliver({ groupId, content });
  }
  if (!groupId) return;
  const docx = await radarDocxBuffer(summary, rows, dateIso);
  const xlsx = await radarXlsxBuffer(periodCode, rows);
  await sendGroupFile(groupId, `Executive Summary - Radar ${periodCode}.docx`, docx);
  await sendGroupFile(groupId, `Game Radar Recap ${periodCode}.xlsx`, xlsx);
}

/** Dựng lại summary từ dòng đã lưu (không research lại) và gửi lại SeaTalk. */
export async function republishRadarRecap(dateIso?: string, opts: { send?: boolean } = {}): Promise<RadarRecapView> {
  const view = await getRadarRecap(dateIso);
  if (!view?.summary) throw new Error("Chưa có recap để gửi lại");
  const prev = await previousRun(dbDate(view.date));
  const summary = buildRadarSummary({
    todayIso: view.date,
    dateLabel: dateLabel(view.date),
    periodCode: view.periodCode,
    rows: view.rows,
    prevRows: prev?.rows ?? [],
    prevDate: prev?.date ?? null,
    prevPeriodCode: prev?.periodCode ?? null,
    carryOver: view.summary.carryOver ?? [],
    testingThisWeek: await testingThisWeek(view.date),
    reportUrl: radarReportUrl(view.date),
  });
  await prismaApp.radarRecapRun.update({
    where: { date: dbDate(view.date) },
    data: { summary: summary as object },
  });
  if (opts.send !== false) await publishRadarNotice(summary, view.rows, view.periodCode, view.date);
  return { ...view, summary };
}
