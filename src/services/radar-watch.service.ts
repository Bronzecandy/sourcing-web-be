import { prismaApp } from "../utils/prisma-app";
import { toPostgresIntAppId } from "../utils/pg-int-app-id";
import { logDiag, logDiagError } from "../utils/process-diagnostics";
import { computeRadarBoards, type RadarBoardEntry } from "./radar-boards";
import { researchRadarGame } from "./radar-research";
import { ictIsoDate, resolveSchedule, scheduleLabel } from "./radar-schedule";
import type { RadarGameFacts, RadarSchedule, ScheduleKind } from "./radar-types";

const WATCH_DELAY_MS = 400;

function dbDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function intOrNull(n: number | null | undefined): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.min(2_147_483_647, Math.max(0, Math.round(n)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function saveRadarSnapshot(iso: string, facts: RadarGameFacts, schedule: RadarSchedule): Promise<void> {
  const appId = toPostgresIntAppId(facts.appId);
  const data = {
    title: facts.title.slice(0, 500),
    reserveCount: intOrNull(facts.reserveCount),
    downloadCount: intOrNull(facts.downloadCount),
    rating: facts.rating,
    flag: intOrNull(facts.flag ?? null),
    releaseDate: facts.releaseDate ?? null,
    scheduleKind: schedule.kind,
    scheduleDate: schedule.date,
    scheduleLabel: schedule.label || null,
    facts: { ...facts, officialPosts: (facts.officialPosts ?? []).slice(0, 6) } as object,
  };
  await prismaApp.radarGameSnapshot.upsert({
    where: { date_appId: { date: dbDate(iso), appId } },
    create: { date: dbDate(iso), appId, ...data },
    update: data,
  });
}

/** Facts đã đọc trong ngày (job watch chạy trước recap tuần) — tránh đọc TapTap 2 lần. */
export async function loadRadarSnapshotFacts(iso: string, appId: number): Promise<RadarGameFacts | null> {
  const row = await prismaApp.radarGameSnapshot.findUnique({
    where: { date_appId: { date: dbDate(iso), appId: toPostgresIntAppId(appId) } },
  });
  return row ? (row.facts as unknown as RadarGameFacts) : null;
}

/** Lịch ghi nhận gần nhất tại hoặc trước ngày `iso`. */
export async function radarScheduleAsOf(appId: number, iso: string): Promise<RadarSchedule | null> {
  const row = await prismaApp.radarGameSnapshot.findFirst({
    where: { appId: toPostgresIntAppId(appId), date: { lte: dbDate(iso) } },
    orderBy: { date: "desc" },
    select: { scheduleKind: true, scheduleDate: true, scheduleLabel: true, date: true },
  });
  if (!row) return null;
  const kind = (row.scheduleKind as ScheduleKind | null) ?? null;
  const snapIso = row.date.toISOString().slice(0, 10);
  return {
    kind,
    date: row.scheduleDate,
    label: row.scheduleLabel ?? scheduleLabel(kind, row.scheduleDate, snapIso),
    source: "info",
    raw: null,
  };
}

/** Đọc lại trang TapTap của toàn bộ game trong 3 bảng Radar (hằng ngày, không gửi SeaTalk). */
export async function runRadarWatch(opts: { boards?: RadarBoardEntry[]; date?: string } = {}): Promise<{
  date: string;
  apps: number;
  saved: number;
  failed: number;
}> {
  const iso = opts.date ?? ictIsoDate();
  const boards = opts.boards ?? (await computeRadarBoards());
  const apps = new Map<number, string>();
  for (const entry of boards) if (!apps.has(entry.appId)) apps.set(entry.appId, entry.title);

  console.log(`[radar-watch] start ${iso} apps=${apps.size}`);
  logDiag("radar-watch-start", { date: iso, apps: apps.size });
  let saved = 0;
  let failed = 0;
  for (const [appId, title] of apps) {
    try {
      const facts = await researchRadarGame(appId, title);
      if (facts.fetched === false) {
        failed += 1;
        continue;
      }
      await saveRadarSnapshot(iso, facts, resolveSchedule(facts, iso));
      saved += 1;
    } catch (err) {
      failed += 1;
      logDiagError("radar-watch-app", err, { appId });
    }
    await sleep(WATCH_DELAY_MS);
  }
  console.log(`[radar-watch] done ${iso} saved=${saved} failed=${failed}`);
  logDiag("radar-watch-done", { date: iso, saved, failed });
  return { date: iso, apps: apps.size, saved, failed };
}
