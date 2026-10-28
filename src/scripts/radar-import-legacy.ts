/**
 * Nhập các kỳ Game Radar Recap làm tay vào lịch sử Radar (status "imported"):
 * data/radar/legacy/legacy-recaps.json, sinh bằng `python scripts/radar-legacy-extract.py <Game Radar Recap.xlsx>`.
 * Không đè kỳ do tool chạy; chạy lại được (thay dòng của kỳ đã nhập).
 *
 *   npm run radar:import-legacy
 */
import "../load-env";
import fs from "fs";
import path from "path";
import { prismaApp } from "../utils/prisma-app";
import { toPostgresIntAppId } from "../utils/pg-int-app-id";
import { seatalkConfig } from "../services/seatalk/config";

interface LegacyRow {
  board: string;
  rank: number;
  appId: number;
  title: string;
  titleEn: string;
  score: number | null;
  chartRank: string;
  trend: string;
  insights: string;
  releaseLabel: string;
  nextActionRaw: string;
  nextAction: string;
  toolAdjustments: string;
  screeningText: string;
  screeningUrl: string | null;
  analysisScore: number | null;
  metricsText: string;
  genre: string;
  publisher: string;
  reason: string;
}

interface LegacyPeriod {
  date: string;
  periodCode: string;
  sheets: string[];
  docx: string | null;
  rows: LegacyRow[];
}

async function main(): Promise<void> {
  const file = path.join(process.cwd(), "data", "radar", "legacy", "legacy-recaps.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as { source: string; periods: LegacyPeriod[] };
  const publicUrl = seatalkConfig().publicUrl;
  let imported = 0;

  for (const period of data.periods) {
    const date = new Date(`${period.date}T00:00:00.000Z`);
    const existing = await prismaApp.radarRecapRun.findUnique({ where: { date }, select: { status: true } });
    if (existing && existing.status !== "imported") {
      console.log(`[legacy] bỏ qua ${period.date}: đã có kỳ do tool chạy (${existing.status})`);
      continue;
    }
    const summary = { legacy: true, source: data.source, sheets: period.sheets, docx: period.docx };
    await prismaApp.radarRecapRun.upsert({
      where: { date },
      create: { date, status: "imported", periodCode: period.periodCode, summary },
      update: { status: "imported", periodCode: period.periodCode, summary },
    });
    await prismaApp.radarRecapRow.deleteMany({ where: { date } });
    await prismaApp.radarRecapRow.createMany({
      data: period.rows.map((r) => ({
        date,
        board: r.board,
        rank: r.rank,
        appId: toPostgresIntAppId(r.appId),
        title: r.title.slice(0, 500),
        titleEn: r.titleEn ? r.titleEn.slice(0, 300) : null,
        score: r.score ?? 0,
        nextAction: r.nextAction,
        insights: r.insights,
        adjustments: r.toolAdjustments,
        screening: r.screeningText || "—",
        payload: {
          ...r,
          legacy: true,
          score: r.score ?? 0,
          overviewUrl: `${publicUrl}/game/${r.appId}`,
          taptapUrl: `https://www.taptap.cn/app/${r.appId}`,
          firstInRecap: false,
          newThisPeriod: false,
        },
      })),
    });
    imported += 1;
    console.log(`[legacy] ${period.date} (kỳ ${period.periodCode}): ${period.rows.length} dòng${period.docx ? `, docx ${period.docx}` : ""}`);
  }
  console.log(`[legacy] xong: nhập ${imported}/${data.periods.length} kỳ`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prismaApp.$disconnect());
