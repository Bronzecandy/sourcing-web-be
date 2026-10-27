/**
 * Import dữ liệu Tester Program từ "Game Tester Profile.xlsx" (chạy 1 lần khi chuyển từ sheet sang web, chạy lại an toàn).
 *   npm run tester:import-sheet -- "C:\path\Game Tester Profile.xlsx"            import
 *   npm run tester:import-sheet -- "<file>" --compare                            + chấm lại bằng AI, in so sánh với Tag Data cũ
 *   npm run tester:import-sheet -- "<file>" --compare --apply                    + ghi điểm AI mới đè điểm sheet
 */
import "../load-env";
import ExcelJS from "exceljs";
import { prismaApp } from "../utils/prisma-app";
import { genreKeyFromLabel, testerConfig } from "../services/tester-config";
import { buildProfile, getActiveSurvey, seedSurveyForm, type SurveyAnswers, type SurveyFormDto } from "../services/tester-survey.service";
import { ensureGameLibrarySeeded, rawHash, scoreGenre, scoreTester } from "../services/tester-scoring.service";
import { PERMISSION_KEYS } from "../types/auth";

type Cell = ExcelJS.CellValue;

function text(v: Cell): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as unknown as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as Array<{ text: string }>).map((r) => r.text).join("");
    if (o.text !== undefined) return String(o.text);
    if (o.result !== undefined) return o.result instanceof Date ? o.result.toISOString().slice(0, 10) : String(o.result);
    return "";
  }
  return String(v);
}

function dateOf(v: Cell): Date | null {
  if (v instanceof Date) return v;
  const o = v as unknown as { result?: unknown } | null;
  if (o && typeof o === "object" && o.result instanceof Date) return o.result;
  const s = text(v).trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dayOnly(d: Date | null): Date | null {
  return d ? new Date(`${d.toISOString().slice(0, 10)}T00:00:00.000Z`) : null;
}

function sheet(wb: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  const ws = wb.worksheets.find((w) => w.name.trim() === name);
  if (!ws) throw new Error(`Không thấy tab "${name}"`);
  return ws;
}

function normEmail(s: string): string {
  return s.trim().toLowerCase();
}

async function ensureUser(email: string, name: string | null): Promise<string> {
  const existing = await prismaApp.user.findUnique({ where: { email } });
  if (existing) return existing.id;
  const user = await prismaApp.user.create({
    data: { email, name, status: "ACTIVE", role: "TESTER", googleSub: null },
  });
  await prismaApp.userPermission.createMany({
    data: PERMISSION_KEYS.map((permissionKey) => ({ userId: user.id, permissionKey, granted: false })),
    skipDuplicates: true,
  });
  return user.id;
}

function mapAnswer(form: SurveyFormDto, code: string, raw: string): string | string[] | null {
  const q = form.questions.find((x) => x.code === code);
  if (!q || !raw.trim()) return null;
  if (q.type === "single") {
    const opt = q.options.find((o) => o.label === raw.trim()) ?? q.options.find((o) => raw.trim().startsWith(o.label.slice(0, 12)));
    return opt ? opt.value : raw.trim();
  }
  if (q.type === "multiple") {
    const out: string[] = [];
    for (const part of raw.split(";").map((p) => p.trim()).filter(Boolean)) {
      const opt = q.options.find((o) => o.label === part) ?? q.options.find((o) => part.startsWith(o.label.slice(0, 12)));
      if (opt) out.push(opt.value);
    }
    return out;
  }
  return raw.trim();
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("Truyền đường dẫn Game Tester Profile.xlsx");
  const compare = process.argv.includes("--compare");
  const apply = process.argv.includes("--apply");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);

  await seedSurveyForm();
  await ensureGameLibrarySeeded();
  const form = await getActiveSurvey();
  const genres = testerConfig.genres().map((g) => g.key);

  // Game Library (gồm cả game AI đã phân loại trên sheet)
  let libraryCount = 0;
  sheet(wb, "Game Library").eachRow((row, rn) => {
    if (rn === 1) return;
    libraryCount += text(row.getCell(1).value).trim() ? 1 : 0;
  });
  for (let rn = 2; rn <= sheet(wb, "Game Library").rowCount; rn++) {
    const row = sheet(wb, "Game Library").getRow(rn);
    const name = text(row.getCell(1).value).trim();
    if (!name) continue;
    const csv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
    const data = {
      aliases: csv(text(row.getCell(2).value)),
      genres: csv(text(row.getCell(3).value)),
      subgenres: csv(text(row.getCell(4).value)),
      source: text(row.getCell(5).value).trim() || "sheet",
      confidence: Number(text(row.getCell(6).value)) || 80,
      notes: text(row.getCell(8).value).trim() || null,
    };
    await prismaApp.gameLibraryEntry.upsert({ where: { canonicalName: name }, create: { canonicalName: name, ...data }, update: data });
  }

  // Genre Data: câu trả lời theo dòng game (đã được chỉnh tay trên sheet) — nguồn raw khi import điểm
  const genreWs = sheet(wb, "Genre Data");
  const genreHeader = new Map<number, string>();
  genreWs.getRow(1).eachCell((c, col) => {
    const key = text(c.value).trim();
    if (genres.includes(key)) genreHeader.set(col, key);
  });
  const rawByEmail = new Map<string, Map<string, string>>();
  genreWs.eachRow((row, rn) => {
    if (rn === 1) return;
    const email = normEmail(text(row.getCell(1).value));
    if (!email.includes("@")) return;
    const map = new Map<string, string>();
    for (const [col, key] of genreHeader) {
      const raw = text(row.getCell(col).value).trim();
      if (raw && !raw.startsWith("=")) map.set(key, raw);
    }
    rawByEmail.set(email, map);
  });

  // Test Survey VN: response gốc
  const survey = sheet(wb, "Test Survey VN");
  const headers = new Map<number, string>();
  survey.getRow(2).eachCell((c, col) => headers.set(col, text(c.value).trim()));
  const colOf = (name: string) => [...headers].find(([, h]) => h === name)?.[0];
  const emailCol = colOf("email")!;
  let responses = 0;
  for (let rn = 3; rn <= survey.rowCount; rn++) {
    const row = survey.getRow(rn);
    const email = normEmail(text(row.getCell(emailCol).value));
    if (!email.includes("@")) continue;
    const answers: SurveyAnswers = {};
    for (const [col, h] of headers) {
      const m = h.match(/^Q(\d+)_/);
      if (!m) continue;
      const value = mapAnswer(form, `Q${m[1]}`, text(row.getCell(col).value));
      if (value != null && (Array.isArray(value) ? value.length > 0 : value !== "")) answers[`Q${m[1]}`] = value;
    }
    const nameQ = form.questions.find((q) => q.semanticKey === "name");
    const name = (nameQ && typeof answers[nameQ.code] === "string" ? (answers[nameQ.code] as string) : null) ?? null;
    const userId = await ensureUser(email, name);
    const submittedAt = dateOf(row.getCell(colOf("submit_at_UTCplus7")!).value) ?? new Date();
    const startedAt = dateOf(row.getCell(colOf("enter_at_UTCplus7")!).value);
    const already = await prismaApp.surveyResponse.findFirst({ where: { userId, source: "sheet-import", submittedAt } });
    const response =
      already ??
      (await prismaApp.surveyResponse.create({
        data: {
          formId: form.id,
          formVersion: form.version,
          userId,
          answers,
          submittedAt,
          startedAt,
          durationSec: Number(text(row.getCell(colOf("time_cost")!).value)) || null,
          device: text(row.getCell(colOf("device")!).value) || null,
          source: "sheet-import",
        },
      }));
    const fields = buildProfile(form, answers, name ?? email);
    await prismaApp.testerProfile.upsert({
      where: { userId },
      create: { userId, ...fields, responseId: response.id, scoringStatus: "scored", scoredAt: new Date() },
      update: { ...fields, responseId: response.id },
    });
    responses += 1;
  }

  // Tag Data: điểm cũ (giữ nguyên, nguồn "sheet")
  const tag = sheet(wb, "Tag Data");
  const tagHeader = new Map<number, string>();
  let favoriteCol = 0;
  tag.getRow(1).eachCell((c, col) => {
    const key = text(c.value).trim();
    if (genres.includes(key)) tagHeader.set(col, key);
    if (key === "Favorite") favoriteCol = col;
  });
  let scores = 0;
  const sheetScores = new Map<string, Map<string, number>>();
  for (let rn = 2; rn <= tag.rowCount; rn++) {
    const row = tag.getRow(rn);
    const email = normEmail(text(row.getCell(1).value));
    if (!email.includes("@")) continue;
    const user = await prismaApp.user.findUnique({ where: { email }, include: { testerProfile: true } });
    if (!user?.testerProfile) continue;
    const raws = rawByEmail.get(email) ?? new Map<string, string>();
    const perUser = new Map<string, number>();
    for (const [col, genre] of tagHeader) {
      const score = Number(text(row.getCell(col).value)) || 0;
      const raw = raws.get(genre) ?? "";
      if (!raw && score <= 0) continue;
      perUser.set(genre, score);
      const data = {
        rawText: raw,
        rawHash: rawHash(genre, raw),
        volumeScore: 0,
        rankScore: 0,
        hasRank: false,
        hours: 0,
        matches: 0,
        anchorGame: null,
        bestRank: null,
        matchedGames: [],
        finalScore: Math.max(0, Math.min(100, Math.round(score))),
        source: "sheet",
        model: null,
      };
      await prismaApp.testerGenreScore.upsert({
        where: { userId_genre: { userId: user.id, genre } },
        create: { userId: user.id, genre, ...data },
        update: data,
      });
      scores += 1;
    }
    sheetScores.set(email, perUser);
    const favorite = favoriteCol ? genreKeyFromLabel(text(row.getCell(favoriteCol).value)) ?? text(row.getCell(favoriteCol).value).trim() : "";
    if (favorite && !user.testerProfile.favoriteGenre) {
      await prismaApp.testerProfile.update({ where: { userId: user.id }, data: { favoriteGenre: favorite } });
    }
  }

  // Game Data + Test Instance Data → đợt test + phân công
  const today = new Date();
  const campaigns = new Map<string, string>();
  const gameWs = sheet(wb, "Game Data");
  for (let rn = 2; rn <= gameWs.rowCount; rn++) {
    const row = gameWs.getRow(rn);
    const gameName = text(row.getCell(1).value).trim();
    if (!gameName) continue;
    const startDate = dayOnly(dateOf(row.getCell(5).value));
    const endDate = dayOnly(dateOf(row.getCell(6).value));
    const status = endDate && endDate < today ? "done" : startDate && startDate <= today ? "running" : "planned";
    const genreText = text(row.getCell(2).value).trim() || null;
    const genreKey = genreText ? genres.find((g) => g.toLowerCase() === genreText.toLowerCase()) : undefined;
    const existing = await prismaApp.testCampaign.findFirst({ where: { gameName, startDate } });
    const campaign =
      existing ??
      (await prismaApp.testCampaign.create({
        data: {
          gameName,
          genre: genreText,
          mainTags: genreKey ? [genreKey] : [],
          secondaryTags: [],
          workloadHours: Number(text(row.getCell(4).value)) || 0,
          startDate,
          endDate,
          status,
          createdBy: "sheet-import",
        },
      }));
    campaigns.set(gameName.toLowerCase(), campaign.id);
  }
  let assignments = 0;
  const instance = sheet(wb, "Test Instance Data");
  for (let rn = 2; rn <= instance.rowCount; rn++) {
    const row = instance.getRow(rn);
    const gameName = text(row.getCell(1).value).trim();
    const email = normEmail(text(row.getCell(2).value));
    const campaignId = campaigns.get(gameName.toLowerCase());
    if (!gameName || !email.includes("@") || !campaignId) continue;
    const userId = await ensureUser(email, null);
    const completed = text(row.getCell(6).value).trim().toUpperCase() === "TRUE";
    const workload = Number(text(row.getCell(3).value));
    await prismaApp.testAssignment.upsert({
      where: { campaignId_userId: { campaignId, userId } },
      create: {
        campaignId,
        userId,
        completed,
        completedAt: completed ? dayOnly(dateOf(row.getCell(5).value)) ?? new Date() : null,
        workloadHours: Number.isFinite(workload) ? workload : null,
      },
      update: { completed },
    });
    assignments += 1;
  }

  // Test Data: Used_benefit
  let redemptions = 0;
  const testData = sheet(wb, "Test Data");
  for (let rn = 2; rn <= testData.rowCount; rn++) {
    const row = testData.getRow(rn);
    const email = normEmail(text(row.getCell(1).value));
    const used = Number(text(row.getCell(8).value)) || 0;
    if (!email.includes("@") || used <= 0) continue;
    const user = await prismaApp.user.findUnique({ where: { email } });
    if (!user) continue;
    const exists = await prismaApp.benefitRedemption.findFirst({ where: { userId: user.id, createdBy: "sheet-import" } });
    if (exists) continue;
    await prismaApp.benefitRedemption.create({
      data: { userId: user.id, amount: used, item: "Đã dùng (import từ sheet)", createdBy: "sheet-import" },
    });
    redemptions += 1;
  }

  console.log(
    JSON.stringify({ library: libraryCount, responses, scores, campaigns: campaigns.size, assignments, redemptions }, null, 2),
  );

  if (!compare) return;
  console.log("\nSo sánh điểm AI (web) với Tag Data cũ:");
  const library = (await prismaApp.gameLibraryEntry.findMany()) as Parameters<typeof scoreGenre>[2];
  let total = 0;
  let absDiff = 0;
  for (const [email, perUser] of sheetScores) {
    const raws = rawByEmail.get(email) ?? new Map<string, string>();
    for (const [genre, old] of perUser) {
      const raw = raws.get(genre);
      if (!raw) continue;
      const r = await scoreGenre(genre, raw, library);
      total += 1;
      absDiff += Math.abs(r.finalScore - old);
      console.log(
        `${email.padEnd(34)} ${genre.padEnd(10)} sheet=${String(old).padStart(3)} web=${String(r.finalScore).padStart(3)} ` +
          `(volume ${r.volumeScore}, rank ${r.hasRank ? r.rankScore : "-"}, ${r.hours}h/${r.matches} trận)`,
      );
    }
  }
  if (total > 0) console.log(`\n${total} cặp tester × dòng game, lệch trung bình ${(absDiff / total).toFixed(1)} điểm`);
  if (apply) {
    for (const email of sheetScores.keys()) {
      const user = await prismaApp.user.findUnique({ where: { email } });
      if (user) await scoreTester(user.id, { force: true });
    }
    console.log("Đã ghi điểm AI mới.");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prismaApp.$disconnect().catch(() => undefined);
  });
