import fs from "fs";
import path from "path";
import { prismaApp } from "../utils/prisma-app";
import { toPostgresIntAppId } from "../utils/pg-int-app-id";
import { logDiag, logDiagError } from "../utils/process-diagnostics";
import { getLatestAnalysisForApp } from "./ai-analysis-store";
import { computePotentialTop20Boards } from "./potential-top20-alert.service";
import { seatalkConfig } from "./seatalk/config";
import { decideRadarGame, writeExecutiveParagraphs } from "./radar-decide";
import { researchRadarGame } from "./radar-research";
import { buildCopyText } from "./radar-copy";
import { radarDocxBuffer, radarXlsxBuffer } from "./radar-export";
import {
  needsScreening,
  type RadarBoardId,
  type RadarRowPayload,
  type RadarSummary,
} from "./radar-types";

const TERMINAL = new Set(["completed"]);

export interface RadarRecapView {
  date: string;
  periodCode: string;
  status: string;
  summary: RadarSummary | null;
  rows: RadarRowPayload[];
}

interface BaselineHit {
  appId: number;
  nextAction: string;
  date: string;
}

function ictToday(now = new Date()): Date {
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

function dateLabel(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${Number(d)}/${Number(m)}/${y}`;
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

export async function getRadarRecap(dateIso?: string): Promise<RadarRecapView | null> {
  const run = dateIso
    ? await prismaApp.radarRecapRun.findUnique({
        where: { date: new Date(`${dateIso}T00:00:00.000Z`) },
        include: { rows: { orderBy: [{ board: "asc" }, { rank: "asc" }] } },
      })
    : await prismaApp.radarRecapRun.findFirst({
        where: { status: "completed" },
        orderBy: { date: "desc" },
        include: { rows: { orderBy: [{ board: "asc" }, { rank: "asc" }] } },
      });
  if (!run) return null;
  return {
    date: run.date.toISOString().slice(0, 10),
    periodCode: run.periodCode,
    status: run.status,
    summary: (run.summary as RadarSummary | null) ?? null,
    rows: rowsFromDb(run.rows),
  };
}

export async function radarFile(dateIso: string, kind: "docx" | "xlsx"): Promise<{ filename: string; body: Buffer } | null> {
  const view = await getRadarRecap(dateIso);
  if (!view?.summary) return null;
  const code = view.periodCode;
  if (kind === "docx") {
    return {
      filename: `Executive Summary - Radar ${code}.docx`,
      body: await radarDocxBuffer(view.summary, view.rows),
    };
  }
  return {
    filename: `Game Radar Recap ${code}.xlsx`,
    body: await radarXlsxBuffer(code, view.rows),
  };
}

async function previousFor(appId: number, today: Date): Promise<{ action: string; date: string } | null> {
  const row = await prismaApp.radarRecapRow.findFirst({
    where: { appId: toPostgresIntAppId(appId), date: { lt: today } },
    orderBy: { date: "desc" },
    select: { nextAction: true, date: true },
  });
  if (row) return { action: row.nextAction, date: row.date.toISOString().slice(0, 10) };
  const hit = loadBaseline().find((b) => b.appId === appId);
  return hit ? { action: hit.nextAction, date: hit.date } : null;
}

async function screeningFor(appId: number, action: string, publicUrl: string): Promise<{
  text: string;
  url: string | null;
  score: number | null;
}> {
  if (!needsScreening(action)) return { text: "—", url: null, score: null };
  const latest = await getLatestAnalysisForApp(appId);
  if (!latest?.analysisId) return { text: "Chưa có — cần screening", url: null, score: null };
  const score = latest.rubric?.aggregate?.weightedScore ?? latest.sentimentScore ?? null;
  const url = `${publicUrl}/ai-analysis/a/${latest.analysisId}`;
  const text = score != null ? `${Math.round(score)} — Xem chi tiết` : "Xem chi tiết";
  return { text, url, score };
}

export async function runRadarRecap(): Promise<{ skipped: boolean; date: string; rows: number }> {
  const today = ictToday();
  const iso = today.toISOString().slice(0, 10);
  const periodCode = iso.slice(5, 7) + iso.slice(8, 10);
  const existing = await prismaApp.radarRecapRun.findUnique({ where: { date: today } });
  if (existing && TERMINAL.has(existing.status)) {
    console.log(`[radar] skip ${iso}: already ${existing.status}`);
    return { skipped: true, date: iso, rows: 0 };
  }
  if (!existing) {
    await prismaApp.radarRecapRun.create({ data: { date: today, status: "started", periodCode } });
  } else {
    await prismaApp.radarRecapRun.update({ where: { date: today }, data: { status: "started", periodCode } });
  }

  console.log(`[radar] start ${iso}`);
  logDiag("radar-recap-start", { date: iso });
  const publicUrl = seatalkConfig().publicUrl;

  try {
    const boards = await computePotentialTop20Boards();
    const picked = boards.flatMap((row) => {
      if (row.board === "reserve_growth" || row.board === "reserve_scale") {
        return [{ ...row, board: row.board as RadarBoardId }];
      }
      if (row.board === "launch_scale") return [{ ...row, board: "new_launch" as const }];
      return [];
    });

    const factsCache = new Map<number, Awaited<ReturnType<typeof researchRadarGame>>>();
    const decisionCache = new Map<string, Awaited<ReturnType<typeof decideRadarGame>>>();
    const rows: RadarRowPayload[] = [];

    for (const entry of picked) {
      try {
        let facts = factsCache.get(entry.appId);
        if (!facts) {
          facts = await researchRadarGame(entry.appId, entry.title);
          factsCache.set(entry.appId, facts);
        }
        const prev = await previousFor(entry.appId, today);
        const cacheKey = `${entry.appId}:${entry.board}`;
        let decision = decisionCache.get(cacheKey);
        if (!decision) {
          const shared = decisionCache.get(`${entry.appId}:*`);
          decision =
            shared ??
            (await decideRadarGame({
              facts,
              boardLabel: entry.board === "new_launch" ? "New Launch" : entry.board === "reserve_growth" ? "Reserve tăng trưởng" : "Reserve quy mô",
              rank: entry.rank,
              score: entry.score,
              previousAction: prev?.action ?? null,
              previousDate: prev?.date ?? null,
            }));
          decisionCache.set(`${entry.appId}:*`, decision);
          decisionCache.set(cacheKey, decision);
        }
        let adjustments = decision.toolAdjustments;
        if (!prev && !adjustments.includes("Game mới")) {
          adjustments = adjustments
            ? `Game mới (chưa có ở recap kỳ trước). ${adjustments}`
            : "Game mới (chưa có ở recap kỳ trước)";
        }
        const screening = await screeningFor(entry.appId, decision.nextAction, publicUrl);
        rows.push({
          ...decision,
          toolAdjustments: adjustments,
          board: entry.board,
          rank: entry.rank,
          appId: entry.appId,
          title: facts.title || entry.title,
          score: entry.score,
          taptapUrl: `https://www.taptap.cn/app/${entry.appId}?from=radar`,
          overviewUrl: `${publicUrl}/game/${entry.appId}`,
          screeningUrl: screening.url,
          analysisScore: screening.score,
          firstInRecap: !prev,
          previousAction: prev?.action ?? null,
          previousDate: prev?.date ?? null,
        });
        console.log(`[radar] ${entry.board} #${entry.rank} ${entry.appId} ${decision.nextAction}`);
      } catch (err) {
        console.warn(`[radar] row failed ${entry.appId}:`, err instanceof Error ? err.message : err);
        logDiagError("radar-recap-row", err, { appId: entry.appId, board: entry.board });
      }
    }

    const brief = rows
      .map((r) => `${r.board} #${r.rank} ${r.title} (${r.titleEn || "—"}) | ${r.nextAction} | ${r.releaseLabel || "chưa lịch"} | ${r.insights}`)
      .join("\n")
      .slice(0, 14000);
    const executiveParagraphs = await writeExecutiveParagraphs(brief);
    const built = buildCopyText({
      dateLabel: dateLabel(iso),
      periodCode,
      rows,
      executiveParagraphs,
    });

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
          screening: row.screeningUrl ? `${row.analysisScore ?? ""} — Xem chi tiết` : row.nextAction.startsWith("Monitor") || row.nextAction.startsWith("Test Viable") ? "Chưa có — cần screening" : "—",
          payload: row as object,
        })),
      });
    }
    await prismaApp.radarRecapRun.update({
      where: { date: today },
      data: { status: "completed", periodCode, summary: built.summary as object },
    });
    console.log(`[radar] done ${iso} rows=${rows.length}`);
    logDiag("radar-recap-done", { date: iso, rows: rows.length });
    return { skipped: false, date: iso, rows: rows.length };
  } catch (err) {
    await prismaApp.radarRecapRun.update({
      where: { date: today },
      data: { status: "failed", summary: { error: err instanceof Error ? err.message : String(err) } },
    }).catch(() => undefined);
    logDiagError("radar-recap-failed", err, { date: iso });
    throw err;
  }
}
