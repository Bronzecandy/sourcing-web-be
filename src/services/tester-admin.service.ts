import ExcelJS from "exceljs";
import { prismaApp } from "../utils/prisma-app";
import { genreLabel, testerConfig } from "./tester-config";
import { queueTesterScoring } from "./tester-scoring.service";
import { getActiveSurvey, validateQuestionnaire, type SurveyAnswers } from "./tester-survey.service";
import { assignmentHours, redemptionTotals, statsFor } from "./tester.service";

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
  benefitRedemptions: { select: { amount: true, status: true } },
} as const;

function rowStats(user: {
  testAssignments: Parameters<typeof statsFor>[0];
  benefitRedemptions: Array<{ amount: number; status: string }>;
}) {
  const totals = redemptionTotals(user.benefitRedemptions);
  return statsFor(user.testAssignments, totals.used, totals.pending);
}

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
  testerType: string | null;
  active: boolean;
  scoringStatus: string;
  scores: Record<string, number>;
  stats: ReturnType<typeof statsFor>;
  submittedAt: string | null;
}

/** Hồ sơ tester; `userIds` không truyền = chỉ user đang có role TESTER. */
export async function testerRows(userIds?: string[]): Promise<TesterRow[]> {
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
    testerType: p.testerType,
    active: p.active,
    scoringStatus: p.scoringStatus,
    scores: Object.fromEntries(p.genreScores.map((s) => [s.genre, s.finalScore])),
    stats: rowStats(p.user),
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
    testerType: null,
    active: true,
    scoringStatus: "no_survey",
    scores: {},
    stats: rowStats(u),
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
    prismaApp.testAssignment.findMany({
      where: { OR: [{ userId }, { email: row.email.toLowerCase() }], status: { not: "added" } },
      include: { campaign: true },
      orderBy: { createdAt: "desc" },
    }),
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
      status: a.status,
      reviewStatus: a.reviewStatus,
      submittedAt: a.submittedAt?.toISOString() ?? null,
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
      status: r.status,
      gameAccount: r.gameAccount,
      adminNote: r.adminNote,
      createdAt: r.createdAt.toISOString(),
      processedAt: r.processedAt?.toISOString() ?? null,
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

const REDEMPTION_FILTERS: Record<string, string[] | null> = {
  pending: ["pending"],
  fulfilled: ["fulfilled"],
  closed: ["rejected", "cancelled"],
  all: null,
};

/** Yêu cầu đổi quà của tester (mặc định: đang chờ trao). */
export async function listRedemptions(filter = "pending") {
  const statuses = REDEMPTION_FILTERS[filter] ?? REDEMPTION_FILTERS.pending!;
  const [rows, counts] = await Promise.all([
    prismaApp.benefitRedemption.findMany({
      where: statuses ? { status: { in: statuses } } : undefined,
      orderBy: { createdAt: statuses?.includes("pending") ? "asc" : "desc" },
      take: 300,
      include: { user: { select: { email: true, name: true, avatarUrl: true, testerProfile: { select: { name: true } } } } },
    }),
    prismaApp.benefitRedemption.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  return {
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) as Record<string, number>,
    items: rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      name: r.user.testerProfile?.name ?? r.user.name ?? r.user.email,
      email: r.user.email,
      avatarUrl: r.user.avatarUrl,
      amount: r.amount,
      item: r.item,
      game: r.game,
      reward: r.reward,
      gameAccount: r.gameAccount,
      note: r.note,
      status: r.status,
      adminNote: r.adminNote,
      createdAt: r.createdAt.toISOString(),
      processedBy: r.processedBy,
      processedAt: r.processedAt?.toISOString() ?? null,
    })),
  };
}

/** PIC xử lý yêu cầu: đã trao quà hoặc từ chối (benefit được hoàn lại). */
export async function processRedemption(id: string, body: { status?: unknown; adminNote?: unknown }, actorEmail: string) {
  const status = body.status === "fulfilled" || body.status === "rejected" ? body.status : null;
  if (!status) throw new TesterAdminError("Trạng thái phải là fulfilled hoặc rejected");
  const adminNote = String(body.adminNote ?? "").trim().slice(0, 300) || null;
  if (status === "rejected" && !adminNote) throw new TesterAdminError("Nhập lý do từ chối để tester biết");
  const r = await prismaApp.benefitRedemption.updateMany({
    where: { id, status: "pending" },
    data: { status, adminNote, processedBy: actorEmail, processedAt: new Date() },
  });
  if (r.count === 0) throw new TesterAdminError("Yêu cầu đã được xử lý hoặc không tồn tại", 409);
  return { id, status };
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
            benefitRedemptions: { select: { amount: true, status: true } },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    }),
    prismaApp.testCampaign.findMany({
      include: { assignments: true },
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
      c.assignments.map((a) => a.email).join("\n"),
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
      instance.addRow([c.gameName, a.email, a.workloadHours ?? c.workloadHours, isoDate(c.startDate), isoDate(c.endDate), a.completed ? "TRUE" : "FALSE"]);
    }
  }
  header(instance);

  const test = book.addWorksheet("Test Data");
  test.addRow(["Email", "Tên", "Cur_test_num", "Cur_test_game", "All_game_tested", "All_test_hour", "All_benefit (3 hour = 1 benefit)", "Used_benefit", "Cur_benefit"]);
  for (const p of profiles) {
    const s = rowStats(p.user);
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
