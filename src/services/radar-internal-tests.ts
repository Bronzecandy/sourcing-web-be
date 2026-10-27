import { prismaApp } from "../utils/prisma-app";
import { toPostgresIntAppId } from "../utils/pg-int-app-id";
import type { RadarInternalTest } from "./radar-types";

const DAY_MS = 86_400_000;

function iso(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function dm(d: Date | null): string {
  return d ? `${d.getUTCDate()}/${d.getUTCMonth() + 1}` : "?";
}

function effectiveStatus(c: { status: string; startDate: Date | null; endDate: Date | null }, todayIso: string): string {
  if (c.status === "done" || c.status === "cancelled") return c.status;
  const start = iso(c.startDate);
  const end = iso(c.endDate);
  if (end && end < todayIso) return "done";
  if (start && start <= todayIso) return "running";
  return "planned";
}

/** Câu tình trạng test nội bộ theo mẫu skill: "Đang test 7/7–10/7", "Đang lên plan, chưa chốt ngày"... */
export function internalTestLabel(
  c: { status: string; startDate: Date | null; endDate: Date | null; result: string | null },
  todayIso: string,
): string {
  const status = effectiveStatus(c, todayIso);
  const range = c.startDate || c.endDate ? `${dm(c.startDate)}–${dm(c.endDate)}` : "";
  if (c.result === "unsuitable") return "Đã test nội bộ, kết quả không phù hợp";
  if (status === "done") return c.result === "suitable" ? `Đã test xong ${range}, kết quả phù hợp` : `Đã test xong ${range}`;
  if (status === "running") return `Đang test ${range}`;
  if (status === "cancelled") return "On hold";
  return range ? `Đã lên lịch test ${range}` : "Đang lên plan, chưa chốt ngày";
}

/** Đợt test mới nhất của từng game (TestCampaign gắn TapTap ID). */
export async function loadInternalTests(appIds: number[], todayIso: string): Promise<Map<number, RadarInternalTest>> {
  const out = new Map<number, RadarInternalTest>();
  if (appIds.length === 0) return out;
  const campaigns = await prismaApp.testCampaign.findMany({
    where: { appId: { in: appIds.map(toPostgresIntAppId) } },
    orderBy: [{ startDate: "desc" }, { createdAt: "desc" }],
  });
  for (const c of campaigns) {
    if (c.appId == null || out.has(c.appId)) continue;
    out.set(c.appId, {
      campaignId: c.id,
      status: effectiveStatus(c, todayIso),
      label: internalTestLabel(c, todayIso),
      startDate: iso(c.startDate),
      endDate: iso(c.endDate),
      team: c.team,
      result: c.result,
    });
  }
  return out;
}

/** "Tên game – team: d/m - d/m" cho các đợt test nội bộ chạy trong tuần của ngày chốt kỳ. */
export async function testingThisWeek(todayIso: string): Promise<string[]> {
  const today = new Date(`${todayIso}T00:00:00.000Z`);
  const monday = new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * DAY_MS);
  const sunday = new Date(monday.getTime() + 6 * DAY_MS);
  const campaigns = await prismaApp.testCampaign.findMany({
    where: {
      status: { in: ["planned", "running"] },
      startDate: { lte: sunday },
      OR: [{ endDate: null }, { endDate: { gte: monday } }],
    },
    orderBy: { startDate: "asc" },
  });
  return campaigns.map((c) => {
    const team = c.team ? ` – ${c.team}` : "";
    return `${c.gameName}${team}: ${dm(c.startDate)} - ${dm(c.endDate)}`;
  });
}
