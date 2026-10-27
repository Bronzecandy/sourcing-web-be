/**
 * Chạy Game Radar Recap thủ công (cron chạy tự động mỗi tuần, xem RADAR_RECAP_WEEKDAY).
 *
 *   npm run radar:recap -- --force               chạy lại kỳ hôm nay và gửi SeaTalk
 *   npm run radar:recap -- --dry --out ./tmp     không ghi DB/không gửi, xuất docx + xlsx ra thư mục
 *   npm run radar:recap -- --date 2026-10-26     chạy cho ngày khác (kỳ MMDD theo ngày đó)
 *   npm run radar:recap -- --no-publish          ghi DB nhưng không gửi SeaTalk
 *   npm run radar:recap -- --watch               chỉ chạy snapshot TapTap hằng ngày
 *   npm run radar:recap -- --republish [--date]  dựng lại summary từ dòng đã lưu và gửi lại
 */
import "../load-env";
import fs from "fs";
import path from "path";
import { prismaApp } from "../utils/prisma-app";
import { pool } from "../utils/prisma";
import { warmLibraryCache } from "../services/library-store";
import { republishRadarRecap, runRadarRecap } from "../services/radar-recap.service";
import { runRadarWatch } from "../services/radar-watch.service";
import { radarDocxBuffer, radarXlsxBuffer } from "../services/radar-export";

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const has = (flag: string) => process.argv.includes(flag);
  const date = argValue("--date");
  await warmLibraryCache();

  if (has("--watch")) {
    console.log(JSON.stringify(await runRadarWatch({ date }), null, 2));
    return;
  }
  if (has("--republish")) {
    const view = await republishRadarRecap(date, { send: !has("--no-publish") });
    console.log(`republished ${view.date} rows=${view.rows.length}`);
    return;
  }

  const result = await runRadarRecap({
    force: has("--force"),
    dryRun: has("--dry"),
    date,
    skipScreening: has("--skip-screening"),
    publish: !has("--no-publish"),
  });
  const out = argValue("--out");
  if (out && result.view?.summary) {
    const dir = path.resolve(out);
    fs.mkdirSync(dir, { recursive: true });
    const code = result.view.periodCode;
    fs.writeFileSync(path.join(dir, `Executive Summary - Radar ${code}.docx`), await radarDocxBuffer(result.view.summary, result.view.rows, result.view.date));
    fs.writeFileSync(path.join(dir, `Game Radar Recap ${code}.xlsx`), await radarXlsxBuffer(code, result.view.rows));
    fs.writeFileSync(path.join(dir, `radar-${code}.json`), JSON.stringify(result.view, null, 2));
    fs.writeFileSync(path.join(dir, `radar-${code}-seatalk.md`), result.view.summary.copyText);
    console.log(`wrote files to ${dir}`);
  }
  console.log(JSON.stringify({ ...result, view: undefined }, null, 2));
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
