/**
 * Dựng lại lịch sử top 20 Potential (bảng PotentialBoardDay) cho N ngày gần nhất: chấm Potential như
 * cron chạy vào từng ngày (cửa sổ 14 ngày crawl kết thúc tại ngày đó) để alert "vắng 60 ngày" đúng ngay.
 *
 *   npm run potential:backfill -- --days 60            # chỉ điền ngày chưa có snapshot
 *   npm run potential:backfill -- --days 60 --overwrite # ghi đè cả ngày đã có (vd snapshot trùng do dữ liệu cũ)
 *   npm run potential:backfill -- --days 60 --dry       # chỉ in, không ghi
 *   npm run potential:backfill -- --verify              # so top 20 hôm nay: tính theo ngày vs tính trực tiếp
 */
import "../load-env";
import { prismaApp } from "../utils/prisma-app";
import { pool } from "../utils/prisma";
import { withForceRefresh } from "../utils/cache";
import { rankingService } from "../services/ranking.service";
import {
  POTENTIAL_TOP20_DAYS,
  computePotentialTop20Boards,
  computePotentialTop20BoardsAsOf,
  formatIctDate,
  saveSnapshot,
  type PotentialTop20Entry,
} from "../services/potential-top20-alert.service";

function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

function shiftIso(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** AppRank.date (DATE) được pg parse thành nửa đêm giờ local. */
function localIsoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function localMidnight(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}

const dbDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function boardKey(e: PotentialTop20Entry): string {
  return `${e.board}#${e.rank}:${e.appId}:${Math.round(e.score * 10) / 10}`;
}

async function verify(todayIso: string): Promise<void> {
  const rows = await rankingService.fetchLightRowsSince(localMidnight(shiftIso(todayIso, -(POTENTIAL_TOP20_DAYS - 1))));
  const asOf = await computePotentialTop20BoardsAsOf(todayIso, rows);
  const live = await withForceRefresh(() => computePotentialTop20Boards());
  const liveKeys = new Set(live.map(boardKey));
  const exact = asOf.filter((e) => !liveKeys.has(boardKey(e))).length;
  const member = (e: PotentialTop20Entry) => `${e.board}:${e.appId}`;
  const liveMembers = new Set(live.map(member));
  const asOfMembers = new Set(asOf.map(member));
  const onlyAsOf = asOf.filter((e) => !liveMembers.has(member(e)));
  const onlyLive = live.filter((e) => !asOfMembers.has(member(e)));
  console.log(
    `[backfill] verify ${todayIso}: ${asOf.length} dòng; lệch hạng/điểm=${exact}; ` +
      `game chỉ có ở bản theo ngày=${onlyAsOf.length}, chỉ có ở bản trực tiếp=${onlyLive.length}`,
  );
  for (const d of onlyAsOf) console.log("  chỉ theo ngày:", boardKey(d));
  for (const d of onlyLive) console.log("  chỉ trực tiếp:", boardKey(d));
}

async function main(): Promise<void> {
  const todayIso = formatIctDate();
  if (process.argv.includes("--verify")) {
    await verify(todayIso);
    return;
  }

  const days = Math.max(1, Number(argValue("--days", "60")) || 60);
  const overwrite = process.argv.includes("--overwrite");
  const dry = process.argv.includes("--dry");
  const targets: string[] = [];
  for (let i = days; i >= 1; i--) targets.push(shiftIso(todayIso, -i));

  const existing = await prismaApp.potentialBoardDay.findMany({
    where: { date: { gte: dbDate(targets[0]!), lt: dbDate(todayIso) } },
    select: { date: true },
    distinct: ["date"],
  });
  const have = new Set(existing.map((e) => e.date.toISOString().slice(0, 10)));
  const todo = overwrite ? targets : targets.filter((t) => !have.has(t));
  console.log(`[backfill] ${targets[0]} → ${targets[targets.length - 1]}: ${todo.length} ngày cần dựng (đã có ${have.size})`);
  if (todo.length === 0) return;

  const rows = await rankingService.fetchLightRowsSince(localMidnight(shiftIso(todo[0]!, -(POTENTIAL_TOP20_DAYS - 1))));
  const crawlDays = new Set(rows.map((r) => localIsoDay(r.date)));
  console.log(`[backfill] ${rows.length} dòng AppRank, ${crawlDays.size} ngày crawl`);

  let written = 0;
  for (const day of todo) {
    if (!crawlDays.has(day)) {
      console.log(`[backfill] ${day}: không có dữ liệu crawl, bỏ qua`);
      continue;
    }
    const entries = await computePotentialTop20BoardsAsOf(day, rows);
    const apps = new Set(entries.map((e) => e.appId)).size;
    console.log(`[backfill] ${day}: ${entries.length} dòng, ${apps} game${dry ? " (dry)" : ""}`);
    if (!dry) {
      await saveSnapshot(dbDate(day), entries);
      written += 1;
    }
  }
  console.log(`[backfill] xong: ghi ${written} ngày`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prismaApp.$disconnect().catch(() => undefined);
    await pool.end().catch(() => undefined);
  });
