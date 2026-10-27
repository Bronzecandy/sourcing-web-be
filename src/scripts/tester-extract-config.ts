/**
 * Sinh cấu hình Tester Program (data/tester/*.json) từ file "Game Tester Profile.xlsx".
 * Chạy lại khi sheet đổi:  npm run tester:extract-config -- "C:\path\Game Tester Profile.xlsx"
 */
import fs from "fs";
import path from "path";
import ExcelJS from "exceljs";

type Cell = ExcelJS.CellValue;

function text(v: Cell): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as unknown as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as Array<{ text: string }>).map((r) => r.text).join("");
    if (o.text !== undefined) return String(o.text);
    if (o.result !== undefined) return String(o.result);
    return "";
  }
  return String(v);
}

function clean(s: string): string {
  return s.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").trim();
}

const GENRE_PATTERNS: Array<[RegExp, string]> = [
  [/^MOBA/i, "MOBA"],
  [/FPS|Bắn Súng/i, "FPS"],
  [/Battle Royale/i, "BR"],
  [/^Auto Chess/i, "Autochess"],
  [/Card\s*RPG|CardRPG/i, "CardRPG"],
  [/^ActionRPG/i, "ARPG"],
  [/^MMORPG/i, "MMORPG"],
  [/^Thể Thao/i, "Sport"],
  [/^Extraction/i, "Extraction"],
  [/SLG|Chiến thuật/i, "SLG"],
  [/^Mô phỏng/i, "Simulator"],
  [/^Casual/i, "Casual"],
  [/^Sandbox/i, "Sandbox"],
  [/^Party/i, "Party"],
  [/^Khác/i, "Other"],
];

export function genreKeyFromLabel(label: string): string | null {
  for (const [re, key] of GENRE_PATTERNS) if (re.test(label.trim())) return key;
  return null;
}

function refs(v: string): number[] {
  return v
    .split("&")
    .map((p) => p.trim().match(/^Q?(\d+)$/i)?.[1])
    .filter((n): n is string => Boolean(n))
    .map(Number);
}

function sheet(wb: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  const ws = wb.worksheets.find((w) => w.name.trim() === name);
  if (!ws) throw new Error(`Không thấy tab "${name}"`);
  return ws;
}

function semanticKey(q: string): string | null {
  if (/Tên bạn/i.test(q)) return "name";
  if (/văn phòng/i.test(q)) return "office";
  if (/phòng ban|team game/i.test(q)) return "team";
  if (/bao nhiêu tuổi/i.test(q)) return "age";
  if (/nền tảng/i.test(q)) return "platforms";
  if (/Giới tính/i.test(q)) return "gender";
  if (/Mỗi tuần.*chơi game/i.test(q)) return "weekly_play";
  if (/Chọn những dòng game/i.test(q)) return "genres";
  if (/"Khác"/.test(q)) return "other_games";
  if (/THÍCH NHẤT/.test(q)) return "favorite_genre";
  if (/bỏ ra bao nhiêu tiền/i.test(q)) return "pay";
  if (/hỗ trợ test game/i.test(q)) return "test_time";
  return null;
}

async function main() {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) throw new Error("Truyền đường dẫn Game Tester Profile.xlsx");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const outDir = path.join(process.cwd(), "data", "tester");
  fs.mkdirSync(outDir, { recursive: true });

  // Mapping
  const map = sheet(wb, "Mapping");
  const weeklyPlay: Array<{ label: string; level: number }> = [];
  const payment: Array<{ label: string; tier: string }> = [];
  const device: Array<{ label: string; key: string }> = [];
  const perspective: Array<{ label: string; key: string }> = [];
  const playtimeBuckets: Array<{ label: string; level: number }> = [];
  let section = "";
  map.eachRow((row, rn) => {
    const a = clean(text(row.getCell(1).value));
    const b = clean(text(row.getCell(2).value));
    const h = clean(text(row.getCell(8).value));
    const i = clean(text(row.getCell(9).value));
    if (rn >= 2 && rn <= 8 && b && /^\d+$/.test(a)) weeklyPlay.push({ label: b, level: Number(a) });
    if (rn >= 2 && rn <= 9 && h && i) payment.push({ label: h, tier: i });
    if (h === "Device" || h === "Perspective" || h === "Playtime") section = h;
    else if (section === "Device" && h && i) device.push({ label: h, key: i });
    else if (section === "Perspective" && h && i) perspective.push({ label: h, key: i });
    else if (section === "Playtime" && h && /^\d+$/.test(i)) playtimeBuckets.push({ label: h, level: Number(i) });
  });
  fs.writeFileSync(
    path.join(outDir, "mapping.json"),
    JSON.stringify({ weeklyPlay, payment, device, perspective, playtimeBuckets }, null, 2) + "\n",
  );

  // Questionnaire (format survey-toolkit)
  const qs = sheet(wb, "Questionnaire");
  type Opt = { label: string; jump: number | null; connect: number[]; fix: boolean; exclusive: boolean; textInput: boolean };
  type Q = {
    number: number;
    text: string;
    type: string;
    mustAnswer: boolean;
    page: number;
    pic: string | null;
    video: string | null;
    regex: string | null;
    semanticKey: string | null;
    genreKey: string | null;
    options: Opt[];
  };
  const questions: Q[] = [];
  let page = 0;
  let current: Q | null = null;
  qs.eachRow((row, rn) => {
    if (rn === 1) return;
    const c = clean(text(row.getCell(1).value));
    const label = clean(text(row.getCell(2).value));
    if (!c && !label) return;
    if (c.toUpperCase() === "N") {
      page += 1;
      current = null;
      return;
    }
    if (/^\d+$/.test(c)) {
      current = {
        number: Number(c),
        text: label,
        type: clean(text(row.getCell(5).value)),
        mustAnswer: clean(text(row.getCell(7).value)).toUpperCase() === "Y",
        page: Math.max(1, page),
        pic: clean(text(row.getCell(3).value)) || null,
        video: clean(text(row.getCell(4).value)) || null,
        regex: clean(text(row.getCell(14).value)) || null,
        semanticKey: semanticKey(label),
        genreKey: null,
        options: [],
      };
      questions.push(current);
      return;
    }
    if (!current) return;
    const q = current as Q;
    const jump = refs(clean(text(row.getCell(8).value)))[0] ?? null;
    q.options.push({
      label,
      jump,
      connect: refs(clean(text(row.getCell(9).value))),
      fix: clean(text(row.getCell(10).value)).toUpperCase() !== "N",
      exclusive: clean(text(row.getCell(11).value)).toUpperCase() === "Y",
      textInput: clean(text(row.getCell(12).value)).toUpperCase() === "Y",
    });
  });
  const byNumber = new Map(questions.map((q) => [q.number, q]));
  const genresQ = questions.find((q) => q.semanticKey === "genres");
  for (const opt of genresQ?.options ?? []) {
    const key = genreKeyFromLabel(opt.label);
    for (const target of opt.connect) {
      const t = byNumber.get(target);
      if (!t) continue;
      t.genreKey = key;
      if (!t.semanticKey) t.semanticKey = key === "Other" ? "other_games" : "genre_detail";
    }
  }
  const questionnaire = {
    slug: "tester-profile",
    version: 1,
    title: "Game Tester Profile",
    introduction:
      "Bảng hỏi giúp team New Games hiểu thói quen chơi game của bạn để mời bạn test đúng dòng game phù hợp. Mất khoảng 10 phút, bạn có thể cập nhật lại bất cứ lúc nào.",
    questions,
  };
  fs.writeFileSync(path.join(outDir, "questionnaire.json"), JSON.stringify(questionnaire, null, 2) + "\n");

  // Experience Library → bucket volume
  const exp = sheet(wb, "Experience Library");
  const hours: Array<[number, number]> = [];
  const matches: Array<[number, number]> = [];
  exp.eachRow((row, rn) => {
    if (rn === 1) return;
    const score = Number(text(row.getCell(1).value));
    const m = Number(text(row.getCell(2).value));
    const h = Number(text(row.getCell(3).value));
    if (!Number.isFinite(score)) return;
    if (Number.isFinite(m)) matches.push([m, score]);
    if (Number.isFinite(h)) hours.push([h, score]);
  });

  // Proficiency Library → bảng rank theo game
  const prof = sheet(wb, "Proficiency Library");
  const scoreRow = prof.getRow(1);
  const levelRow = prof.getRow(2);
  const levels: Array<{ score: number; label: string }> = [];
  for (let col = 2; col <= 7; col++) {
    levels.push({ score: Number(text(scoreRow.getCell(col).value)), label: clean(text(levelRow.getCell(col).value)) });
  }
  const games: Array<{ game: string; tiers: string[] }> = [];
  prof.eachRow((row, rn) => {
    if (rn <= 2) return;
    const game = clean(text(row.getCell(1).value));
    if (!game) return;
    games.push({ game, tiers: levels.map((_, i) => clean(text(row.getCell(i + 2).value))) });
  });
  fs.writeFileSync(
    path.join(outDir, "scoring.json"),
    JSON.stringify({ volume: { hours, matches, vagueHours: 50 }, rank: { levels, games } }, null, 2) + "\n",
  );

  // Internal Deploy & Benefit
  const dep = sheet(wb, "Internal Deploy & Benefit");
  const groupKeys: Array<[RegExp, string]> = [
    [/Action/i, "action"],
    [/CardRPG|IdleRPG/i, "card"],
    [/Casual/i, "casual"],
    [/ARPG|MMORPG/i, "rpg"],
  ];
  const workload: Array<{ key: string; label: string; testDays: number; hoursPerDay: number; workloadHours: number; weight: number }> = [];
  const teamRequests: Array<{ team: string; items: string[] }> = [];
  const tiers: Array<{ condition: string; items: Array<{ game: string; reward: string; pic: string }> }> = [];
  dep.eachRow((row, rn) => {
    if (rn === 1) return;
    const label = clean(text(row.getCell(1).value));
    if (label) {
      const key = groupKeys.find(([re]) => re.test(label))?.[1] ?? label.toLowerCase();
      workload.push({
        key,
        label,
        testDays: Number(text(row.getCell(2).value)) || 0,
        hoursPerDay: Number(text(row.getCell(3).value)) || 0,
        workloadHours: Number(text(row.getCell(4).value)) || 0,
        weight: Number(text(row.getCell(5).value)) || 1,
      });
    }
    const team = clean(text(row.getCell(11).value)).replace(/^-\s*/, "").replace(/:$/, "");
    const item = clean(text(row.getCell(12).value)).replace(/^-\s*/, "");
    if (team && item) {
      const entry = teamRequests.find((t) => t.team === team) ?? { team, items: [] };
      if (!teamRequests.includes(entry)) teamRequests.push(entry);
      entry.items.push(item);
    }
    const m = clean(text(row.getCell(13).value));
    const n = clean(text(row.getCell(14).value));
    const o = clean(text(row.getCell(15).value));
    if (/^Condition:/i.test(m)) tiers.push({ condition: m.replace(/^Condition:\s*/i, ""), items: [] });
    else if (m && n && tiers.length > 0) tiers[tiers.length - 1]!.items.push({ game: m, reward: n, pic: o });
  });
  fs.writeFileSync(
    path.join(outDir, "workload.json"),
    JSON.stringify({ groups: workload, benefitHoursPerUnit: 3 }, null, 2) + "\n",
  );
  fs.writeFileSync(path.join(outDir, "benefits.json"), JSON.stringify({ tiers, teamRequests }, null, 2) + "\n");

  // Game Library (seed cho chấm hardcore)
  const lib = sheet(wb, "Game Library");
  const library: Array<{ canonicalName: string; aliases: string[]; genres: string[]; subgenres: string[]; source: string; confidence: number; notes: string }> = [];
  const csv = (s: string) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  lib.eachRow((row, rn) => {
    if (rn === 1) return;
    const name = clean(text(row.getCell(1).value));
    if (!name) return;
    library.push({
      canonicalName: name,
      aliases: csv(clean(text(row.getCell(2).value))),
      genres: csv(clean(text(row.getCell(3).value))),
      subgenres: csv(clean(text(row.getCell(4).value))),
      source: clean(text(row.getCell(5).value)) || "sheet",
      confidence: Number(text(row.getCell(6).value)) || 80,
      notes: clean(text(row.getCell(8).value)),
    });
  });
  fs.writeFileSync(path.join(outDir, "game-library.json"), JSON.stringify(library, null, 2) + "\n");

  console.log(
    JSON.stringify(
      {
        questions: questions.length,
        options: questions.reduce((n, q) => n + q.options.length, 0),
        mapping: { weeklyPlay: weeklyPlay.length, payment: payment.length, device: device.length },
        workloadGroups: workload.length,
        benefitTiers: tiers.length,
        teamRequests: teamRequests.length,
        hoursBuckets: hours.length,
        rankGames: games.length,
        library: library.length,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
