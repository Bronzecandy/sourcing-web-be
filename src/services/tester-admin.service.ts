import ExcelJS from "exceljs";
import { prismaApp } from "../utils/prisma-app";
import { genreLabel, testerConfig } from "./tester-config";
import { queueTesterScoring } from "./tester-scoring.service";
import { getActiveSurvey, validateQuestionnaire, type SurveyAnswers } from "./tester-survey.service";
import { assignmentHours, statsFor } from "./tester.service";

const PLATFORMS = new Set(["MB", "PC", "CS"]);
const STATUSES = new Set(["planned", "running", "done", "cancelled"]);
const RESULTS = new Set(["suitable", "unsuitable"]);

export class TesterAdminError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

function isoDate(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function parseDate(v: unknown): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T00:00:00.000Z`);
  throw new TesterAdminError("Ngày không hợp lệ (YYYY-MM-DD)");
}

function parseAppId(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const s = String(v).trim();
  const m = s.match(/\/app\/(\d+)/) ?? s.match(/^(\d+)$/);
  if (!m) throw new TesterAdminError("TapTap ID không hợp lệ");
  const n = Number(m[1]);
  if (n > 2_147_483_647) throw new TesterAdminError("TapTap ID quá lớn");
  return n;
}

function tags(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  const keys = new Set(testerConfig.genres().map((g) => g.key));
  const list = Array.isArray(v) ? v : String(v ?? "").split(/[,;|\n]/);
  return [...new Set(list.map((x) => String(x).trim()).filter((x) => keys.has(x)))];
}

export function adminMeta() {
  return {
    genres: testerConfig.genres().map((g) => ({ key: g.key, label: g.label, workloadGroup: g.workloadGroup })),
    workload: testerConfig.workload().groups,
    platforms: testerConfig.mapping().device.map((d) => ({ key: d.key, label: d.label })),
    benefitHoursPerUnit: testerConfig.workload().benefitHoursPerUnit,
    catalog: testerConfig.benefits(),
  };
}

/** Khối lượng mặc định (giờ) theo tab Internal Deploy & Benefit cho dòng game chính. */
export function defaultWorkload(mainGenre: string | null | undefined): number {
  const group = testerConfig.genres().find((g) => g.key === mainGenre)?.workloadGroup;
  const hit = testerConfig.workload().groups.find((g) => g.key === group);
  return hit?.workloadHours ?? 3;
}

const ROW_USER_SELECT = {
  email: true,
  avatarUrl: true,
  roles: true,
  testAssignments: { include: { campaign: true } },
  benefitRedemptions: { select: { amount: true } },
} as const;

interface TesterRow {
  userId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  roles: string[];
  hasProfile: boolean;
  office: string | null;
  team: string | null;
  platforms: string[];
  favoriteGenre: string | null;
  weeklyPlayLabel: string | null;
  testTimeLabel: string | null;
  payTier: string | null;
  active: boolean;
  scoringStatus: string;
  scores: Record<string, number>;
  stats: ReturnType<typeof statsFor>;
  submittedAt: string | null;
}

/** Hồ sơ tester; `userIds` không truyền = chỉ user đang có role TESTER. */
async function testerRows(userIds?: string[]): Promise<TesterRow[]> {
  const profiles = await prismaApp.testerProfile.findMany({
    where: userIds ? { userId: { in: userIds } } : { user: { roles: { has: "TESTER" } } },
    include: {
      user: {
        select: {
          ...ROW_USER_SELECT,
          surveyResponses: { orderBy: { submittedAt: "desc" }, take: 1, select: { submittedAt: true } },
        },
      },
      genreScores: true,
    },
    orderBy: { createdAt: "desc" },
  });
  return profiles.map((p) => ({
    userId: p.userId,
    email: p.user.email,
    name: p.name,
    avatarUrl: p.user.avatarUrl,
    roles: p.user.roles,
    hasProfile: true,
    office: p.office,
    team: p.team,
    platforms: p.platforms,
    favoriteGenre: p.favoriteGenre,
    weeklyPlayLabel: p.weeklyPlayLabel,
    testTimeLabel: p.testTimeLabel,
    payTier: p.payTier,
    active: p.active,
    scoringStatus: p.scoringStatus,
    scores: Object.fromEntries(p.genreScores.map((s) => [s.genre, s.finalScore])),
    stats: statsFor(
      p.user.testAssignments,
      p.user.benefitRedemptions.reduce((sum, r) => sum + r.amount, 0),
    ),
    submittedAt: p.user.surveyResponses[0]?.submittedAt.toISOString() ?? null,
  }));
}

/** Có role TESTER nhưng chưa làm khảo sát. */
async function noSurveyRows(userIds?: string[]): Promise<TesterRow[]> {
  const users = await prismaApp.user.findMany({
    where: {
      roles: { has: "TESTER" },
      testerProfile: { is: null },
      ...(userIds ? { id: { in: userIds } } : {}),
    },
    select: { id: true, name: true, ...ROW_USER_SELECT },
    orderBy: { createdAt: "desc" },
  });
  return users.map((u) => ({
    userId: u.id,
    email: u.email,
    name: u.name ?? u.email,
    avatarUrl: u.avatarUrl,
    roles: u.roles,
    hasProfile: false,
    office: null,
    team: null,
    platforms: [],
    favoriteGenre: null,
    weeklyPlayLabel: null,
    testTimeLabel: null,
    payTier: null,
    active: true,
    scoringStatus: "no_survey",
    scores: {},
    stats: statsFor(
      u.testAssignments,
      u.benefitRedemptions.reduce((sum, r) => sum + r.amount, 0),
    ),
    submittedAt: null,
  }));
}

export async function listTesters() {
  const [profiles, noSurvey] = await Promise.all([testerRows(), noSurveyRows()]);
  return [...profiles, ...noSurvey];
}

async function testerRow(userId: string): Promise<TesterRow | undefined> {
  const [row] = await testerRows([userId]);
  return row ?? (await noSurveyRows([userId]))[0];
}

export async function testerDetail(userId: string) {
  const row = await testerRow(userId);
  if (!row) throw new TesterAdminError("Không tìm thấy tester", 404);
  const [latest, scores, assignments, redemptions] = await Promise.all([
    prismaApp.surveyResponse.findFirst({ where: { userId }, orderBy: { submittedAt: "desc" } }),
    prismaApp.testerGenreScore.findMany({ where: { userId }, orderBy: { finalScore: "desc" } }),
    prismaApp.testAssignment.findMany({ where: { userId }, include: { campaign: true }, orderBy: { createdAt: "desc" } }),
    prismaApp.benefitRedemption.findMany({ where: { userId }, orderBy: { createdAt: "desc" } }),
  ]);
  return {
    ...row,
    answers: (latest?.answers as SurveyAnswers | undefined) ?? null,
    genreScores: scores.map((s) => ({
      genre: s.genre,
      label: genreLabel(s.genre),
      finalScore: s.finalScore,
      volumeScore: s.volumeScore,
      rankScore: s.rankScore,
      hasRank: s.hasRank,
      hours: s.hours,
      matches: s.matches,
      anchorGame: s.anchorGame,
      bestRank: s.bestRank,
      rawText: s.rawText,
      source: s.source,
      matchedGames: Array.isArray(s.matchedGames) ? (s.matchedGames as string[]) : [],
    })),
    assignments: assignments.map((a) => ({
      id: a.id,
      completed: a.completed,
      completedAt: a.completedAt?.toISOString() ?? null,
      workloadHours: assignmentHours(a),
      campaign: {
        id: a.campaign.id,
        gameName: a.campaign.gameName,
        appId: a.campaign.appId,
        genre: a.campaign.genre,
        platform: a.campaign.platform,
        startDate: isoDate(a.campaign.startDate),
        endDate: isoDate(a.campaign.endDate),
        status: a.campaign.status,
      },
    })),
    redemptions: redemptions.map((r) => ({
      id: r.id,
      amount: r.amount,
      item: r.item,
      note: r.note,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

export async function updateTester(userId: string, body: { active?: unknown }) {
  if (typeof body.active === "boolean") {
    const updated = await prismaApp.testerProfile.updateMany({ where: { userId }, data: { active: body.active } });
    if (updated.count === 0) throw new TesterAdminError("Tester chưa làm khảo sát", 409);
  }
  const row = await testerRow(userId);
  if (!row) throw new TesterAdminError("Không tìm thấy tester", 404);
  return row;
}

export function rescoreTester(userId: string): { queued: boolean } {
  queueTesterScoring(userId, { force: true });
  return { queued: true };
}

interface CampaignRow {
  id: string;
  gameName: string;
  appId: number | null;
  genre: string | null;
  platform: string | null;
  mainTags: string[];
  secondaryTags: string[];
  workloadHours: number;
  startDate: Date | null;
  endDate: Date | null;
  team: string | null;
  status: string;
  result: string | null;
  resultNote: string | null;
  assignments: Array<{ completed: boolean }>;
}

async function loadCampaign(id: string) {
  return prismaApp.testCampaign.findUnique({
    where: { id },
    include: { assignments: { include: { user: { select: { email: true, name: true, testerProfile: { select: { name: true } } } } } } },
  });
}

function campaignDto(c: CampaignRow) {
  return {
    id: c.id,
    gameName: c.gameName,
    appId: c.appId,
    genre: c.genre,
    platform: c.platform,
    mainTags: c.mainTags,
    secondaryTags: c.secondaryTags,
    workloadHours: c.workloadHours,
    startDate: isoDate(c.startDate),
    endDate: isoDate(c.endDate),
    team: c.team,
    status: c.status,
    result: c.result,
    resultNote: c.resultNote,
    assignedCount: c.assignments.length,
    completedCount: c.assignments.filter((a) => a.completed).length,
  };
}

export async function listCampaigns() {
  const rows = await prismaApp.testCampaign.findMany({
    include: { assignments: { select: { completed: true } } },
    orderBy: [{ startDate: "desc" }, { createdAt: "desc" }],
  });
  return rows.map((c) => campaignDto(c));
}

export async function campaignDetail(id: string) {
  const c = await loadCampaign(id);
  if (!c) throw new TesterAdminError("Không tìm thấy đợt test", 404);
  return {
    ...campaignDto(c),
    assignments: c.assignments.map((a) => ({
      id: a.id,
      userId: a.userId,
      name: a.user.testerProfile?.name ?? a.user.name ?? a.user.email,
      email: a.user.email,
      workloadHours: a.workloadHours ?? c.workloadHours,
      completed: a.completed,
      completedAt: a.completedAt?.toISOString() ?? null,
    })),
  };
}

function campaignData(body: Record<string, unknown>) {
  const mainTags = tags(body.mainTags);
  const platform = body.platform === undefined ? undefined : body.platform ? String(body.platform) : null;
  if (platform && !PLATFORMS.has(platform)) throw new TesterAdminError("Platform phải là MB, PC hoặc CS");
  const status = body.status === undefined ? undefined : String(body.status);
  if (status && !STATUSES.has(status)) throw new TesterAdminError("Trạng thái không hợp lệ");
  const result = body.result === undefined ? undefined : body.result ? String(body.result) : null;
  if (result && !RESULTS.has(result)) throw new TesterAdminError("Kết quả không hợp lệ");
  const workload = body.workloadHours === undefined || body.workloadHours === "" ? undefined : Number(body.workloadHours);
  if (workload !== undefined && (!Number.isFinite(workload) || workload < 0)) throw new TesterAdminError("Khối lượng không hợp lệ");
  return {
    ...(body.gameName !== undefined ? { gameName: String(body.gameName).trim() } : {}),
    ...(body.appId !== undefined ? { appId: parseAppId(body.appId) } : {}),
    ...(body.genre !== undefined ? { genre: body.genre ? String(body.genre).trim() : null } : {}),
    ...(platform !== undefined ? { platform } : {}),
    ...(mainTags !== undefined ? { mainTags } : {}),
    ...(body.secondaryTags !== undefined ? { secondaryTags: tags(body.secondaryTags) } : {}),
    ...(workload !== undefined ? { workloadHours: workload } : {}),
    ...(body.startDate !== undefined ? { startDate: parseDate(body.startDate) } : {}),
    ...(body.endDate !== undefined ? { endDate: parseDate(body.endDate) } : {}),
    ...(body.team !== undefined ? { team: body.team ? String(body.team).trim() : null } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(body.resultNote !== undefined ? { resultNote: body.resultNote ? String(body.resultNote) : null } : {}),
  };
}

export async function createCampaign(body: Record<string, unknown>, actorEmail: string) {
  const data = campaignData(body);
  if (!data.gameName) throw new TesterAdminError("Cần tên game");
  const created = await prismaApp.testCampaign.create({
    data: {
      ...data,
      gameName: data.gameName,
      workloadHours: data.workloadHours ?? defaultWorkload(data.mainTags?.[0]),
      createdBy: actorEmail,
    },
  });
  return campaignDetail(created.id);
}

export async function updateCampaign(id: string, body: Record<string, unknown>) {
  const data = campaignData(body);
  if (data.gameName === "") throw new TesterAdminError("Cần tên game");
  await prismaApp.testCampaign.update({ where: { id }, data });
  return campaignDetail(id);
}

export async function deleteCampaign(id: string) {
  await prismaApp.testCampaign.delete({ where: { id } });
  return { deleted: true };
}

/**
 * Port recommendTestersSimple (Profile Analyst.gs): trung bình có trọng số điểm dòng game
 * (main 1.0, secondary 0.5), cờ Favorite khi main tag trùng dòng thích nhất; thêm lọc platform.
 */
export async function recommendTesters(campaignId: string, opts: { limit?: number; platformFilter?: boolean } = {}) {
  const campaign = await prismaApp.testCampaign.findUnique({
    where: { id: campaignId },
    include: { assignments: { select: { userId: true } } },
  });
  if (!campaign) throw new TesterAdminError("Không tìm thấy đợt test", 404);
  const main = campaign.mainTags;
  const secondary = campaign.secondaryTags.filter((t) => !main.includes(t));
  if (main.length === 0 && secondary.length === 0) throw new TesterAdminError("Đợt test chưa có Main/Secondary tag");
  const assigned = new Set(campaign.assignments.map((a) => a.userId));
  const rows = await testerRows();
  const limit = Math.max(1, Math.min(50, opts.limit ?? 7));
  return rows
    .filter((r) => r.active)
    .filter((r) => !(opts.platformFilter !== false && campaign.platform) || r.platforms.includes(campaign.platform!))
    .map((r) => {
      let sum = 0;
      let weight = 0;
      for (const t of main) {
        sum += (r.scores[t] ?? 0) * 1;
        weight += 1;
      }
      for (const t of secondary) {
        sum += (r.scores[t] ?? 0) * 0.5;
        weight += 0.5;
      }
      return {
        userId: r.userId,
        name: r.name,
        email: r.email,
        score: weight > 0 ? Math.round(sum / weight) : 0,
        favorite: Boolean(r.favoriteGenre && main.includes(r.favoriteGenre)),
        platforms: r.platforms,
        activeTests: r.stats.activeTests,
        testTimeLabel: r.testTimeLabel,
        assigned: assigned.has(r.userId),
      };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.favorite) - Number(a.favorite))
    .slice(0, limit);
}

export async function assignTesters(campaignId: string, userIds: unknown) {
  const ids = Array.isArray(userIds) ? userIds.filter((x): x is string => typeof x === "string") : [];
  if (ids.length === 0) throw new TesterAdminError("Chưa chọn tester");
  await prismaApp.testAssignment.createMany({
    data: ids.map((userId) => ({ campaignId, userId })),
    skipDuplicates: true,
  });
  return campaignDetail(campaignId);
}

export async function updateAssignment(id: string, body: { completed?: unknown; workloadHours?: unknown }) {
  const data: { completed?: boolean; completedAt?: Date | null; workloadHours?: number | null } = {};
  if (typeof body.completed === "boolean") {
    data.completed = body.completed;
    data.completedAt = body.completed ? new Date() : null;
  }
  if (body.workloadHours === null || body.workloadHours === "") data.workloadHours = null;
  else if (body.workloadHours !== undefined) {
    const n = Number(body.workloadHours);
    if (!Number.isFinite(n) || n < 0) throw new TesterAdminError("Khối lượng không hợp lệ");
    data.workloadHours = n;
  }
  const a = await prismaApp.testAssignment.update({ where: { id }, data });
  return { id: a.id };
}

export async function removeAssignment(id: string) {
  await prismaApp.testAssignment.delete({ where: { id } });
  return { deleted: true };
}

export async function addRedemption(body: Record<string, unknown>, actorEmail: string) {
  const userId = String(body.userId ?? "");
  const amount = Number(body.amount);
  const item = String(body.item ?? "").trim();
  if (!userId || !Number.isInteger(amount) || amount <= 0 || !item) {
    throw new TesterAdminError("Cần tester, số benefit (số nguyên dương) và phần quà");
  }
  const r = await prismaApp.benefitRedemption.create({
    data: { userId, amount, item, note: body.note ? String(body.note) : null, createdBy: actorEmail },
  });
  return { id: r.id };
}

export async function deleteRedemption(id: string) {
  await prismaApp.benefitRedemption.delete({ where: { id } });
  return { deleted: true };
}

export async function surveyReport() {
  const [form, responses] = await Promise.all([getActiveSurvey(), prismaApp.surveyResponse.count()]);
  return { form, report: validateQuestionnaire(testerConfig.questionnaire()), responses };
}

/** Xuất xlsx theo layout các tab cũ (Basic Profile, Tag Data, Genre Data, Game Data, Test Instance Data, Test Data). */
export async function exportTesterWorkbook(): Promise<Buffer> {
  const genres = testerConfig.genres();
  const [profiles, campaigns] = await Promise.all([
    prismaApp.testerProfile.findMany({
      include: {
        genreScores: true,
        user: {
          select: {
            email: true,
            testAssignments: { include: { campaign: true } },
            benefitRedemptions: { select: { amount: true } },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    }),
    prismaApp.testCampaign.findMany({
      include: { assignments: { include: { user: { select: { email: true } } } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const book = new ExcelJS.Workbook();
  const header = (ws: ExcelJS.Worksheet) => {
    ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ws.getRow(1).eachCell((c) => {
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF09026B" } };
    });
    ws.views = [{ state: "frozen", ySplit: 1 }];
  };

  const basic = book.addWorksheet("Basic Profile");
  basic.addRow(["Mail", "Tên", "Base", "Team", "Tuổi", "Platform", "Gender", "Game Time", "Pay Willing", "Test Willing", "Active"]);
  for (const p of profiles) {
    basic.addRow([
      p.user.email,
      p.name,
      p.office,
      p.team,
      p.ageRange,
      p.platforms.join(";"),
      p.gender,
      p.weeklyPlayLabel,
      p.payLabel,
      p.testTimeLabel,
      p.active ? "TRUE" : "FALSE",
    ]);
  }
  header(basic);

  const tag = book.addWorksheet("Tag Data");
  tag.addRow(["Mail", "Tên", ...genres.map((g) => g.key), "Favorite"]);
  for (const p of profiles) {
    const map = new Map(p.genreScores.map((s) => [s.genre, s.finalScore]));
    tag.addRow([p.user.email, p.name, ...genres.map((g) => map.get(g.key) ?? 0), p.favoriteGenre ?? ""]);
  }
  header(tag);

  const genreSheet = book.addWorksheet("Genre Data");
  genreSheet.addRow(["Mail", "Tên", ...genres.map((g) => g.key), "Favorite"]);
  for (const p of profiles) {
    const map = new Map(p.genreScores.map((s) => [s.genre, s.rawText]));
    genreSheet.addRow([p.user.email, p.name, ...genres.map((g) => map.get(g.key) ?? ""), p.favoriteGenre ?? ""]);
  }
  header(genreSheet);

  const game = book.addWorksheet("Game Data");
  game.addRow(["Name", "Genre", "Tester Emails", "Workload", "Start_Date", "End_date", "TapTap ID", "Main Tags", "Secondary Tags", "Platform", "Status", "Result"]);
  for (const c of campaigns) {
    game.addRow([
      c.gameName,
      c.genre,
      c.assignments.map((a) => a.user.email).join("\n"),
      c.workloadHours,
      isoDate(c.startDate),
      isoDate(c.endDate),
      c.appId,
      c.mainTags.join(", "),
      c.secondaryTags.join(", "),
      c.platform,
      c.status,
      c.result,
    ]);
  }
  header(game);

  const instance = book.addWorksheet("Test Instance Data");
  instance.addRow(["Name", "Tester Email", "Workload", "Start_date", "End_date", "Complete_test"]);
  for (const c of campaigns) {
    for (const a of c.assignments) {
      instance.addRow([c.gameName, a.user.email, a.workloadHours ?? c.workloadHours, isoDate(c.startDate), isoDate(c.endDate), a.completed ? "TRUE" : "FALSE"]);
    }
  }
  header(instance);

  const test = book.addWorksheet("Test Data");
  test.addRow(["Email", "Tên", "Cur_test_num", "Cur_test_game", "All_game_tested", "All_test_hour", "All_benefit (3 hour = 1 benefit)", "Used_benefit", "Cur_benefit"]);
  for (const p of profiles) {
    const used = p.user.benefitRedemptions.reduce((sum, r) => sum + r.amount, 0);
    const s = statsFor(p.user.testAssignments, used);
    test.addRow([
      p.user.email,
      p.name,
      s.activeTests,
      s.activeGames.join(", "),
      s.completedTests,
      s.completedHours,
      s.earnedBenefits,
      s.usedBenefits,
      s.availableBenefits,
    ]);
  }
  header(test);

  for (const ws of book.worksheets) ws.columns.forEach((col) => (col.width = 18));
  return Buffer.from(await book.xlsx.writeBuffer());
}
