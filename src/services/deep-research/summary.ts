import { marketDataConfigured } from "../../utils/market-data";
import { prismaApp } from "../../utils/prisma-app";
import { ensureMappings } from "./mapping";
import { addMonths, lastFullMonth, stMonthSnapshots } from "./st-data";
import type { Country, MapStatus, MonthSnapshot, RunStatus, Verdict } from "./types";

export interface MarketSummaryItem {
  st: { status: MapStatus; name: string | null; unifiedId: string | null };
  steam: { status: MapStatus; name: string | null };
  lastMonth: {
    country: Country;
    month: string;
    revenueUsd: number | null;
    avgDau: number | null;
    downloads: number | null;
    revenueMoM: number | null;
    dauMoM: number | null;
  } | null;
  latestRun: { id: string; status: RunStatus; verdict: Verdict | null; marketScore: number | null; finishedAt: string | null } | null;
}

const mom = (cur: number | null | undefined, prev: number | null | undefined) => (cur != null && prev != null && prev > 0 ? cur / prev - 1 : null);
const filled = (s: MonthSnapshot | undefined) => Boolean(s && ((s.revenueUsd ?? 0) > 0 || (s.avgDau ?? 0) > 0));

export async function marketSummary(appIds: number[]): Promise<{ configured: boolean; month: string; items: Record<number, MarketSummaryItem> }> {
  const ids = [...new Set(appIds.filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, 300);
  const month = lastFullMonth();
  const items: Record<number, MarketSummaryItem> = {};
  if (!ids.length) return { configured: marketDataConfigured(), month, items };

  const mappings = await ensureMappings(ids);
  const uids = [...new Set([...mappings.values()].filter((m) => (m.stStatus === "auto" || m.stStatus === "confirmed") && m.stUnifiedId).map((m) => m.stUnifiedId!))].sort();
  const prevMonth = addMonths(month, -1);
  const snaps = marketDataConfigured() && uids.length ? await stMonthSnapshots(uids, [month, prevMonth]) : new Map<string, MonthSnapshot[]>();
  const runs = await prismaApp.deepResearchRun.findMany({
    where: { appId: { in: ids } },
    orderBy: { createdAt: "desc" },
    distinct: ["appId"],
    select: { id: true, appId: true, status: true, verdict: true, marketScore: true, finishedAt: true },
  });
  const runByApp = new Map(runs.map((r) => [r.appId, r]));

  for (const appId of ids) {
    const m = mappings.get(appId);
    const rows = m?.stUnifiedId ? (snaps.get(m.stUnifiedId) ?? []) : [];
    const pick = (c: Country) => ({ cur: rows.find((r) => r.country === c && r.month === month), prev: rows.find((r) => r.country === c && r.month === prevMonth) });
    const cn = pick("CN");
    const chosen = filled(cn.cur) ? { country: "CN" as Country, ...cn } : { country: "WW" as Country, ...pick("WW") };
    const run = runByApp.get(appId);
    items[appId] = {
      st: { status: (m?.stStatus as MapStatus) ?? "unmapped", name: m?.stName ?? null, unifiedId: m?.stUnifiedId ?? null },
      steam: { status: (m?.steamStatus as MapStatus) ?? "unmapped", name: m?.steamName ?? null },
      lastMonth: filled(chosen.cur)
        ? {
            country: chosen.country,
            month,
            revenueUsd: chosen.cur!.revenueUsd,
            avgDau: chosen.cur!.avgDau,
            downloads: chosen.cur!.downloads,
            revenueMoM: mom(chosen.cur!.revenueUsd, chosen.prev?.revenueUsd),
            dauMoM: mom(chosen.cur!.avgDau, chosen.prev?.avgDau),
          }
        : null,
      latestRun: run
        ? { id: run.id, status: run.status as RunStatus, verdict: (run.verdict as Verdict | null) ?? null, marketScore: run.marketScore, finishedAt: run.finishedAt?.toISOString() ?? null }
        : null,
    };
  }
  return { configured: marketDataConfigured(), month, items };
}
