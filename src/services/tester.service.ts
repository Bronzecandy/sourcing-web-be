import { prismaApp } from "../utils/prisma-app";
import type { AuthUserDto } from "../types/auth";
import { ensureTesterRole } from "./auth.service";
import { genreLabel, testerConfig } from "./tester-config";
import { queueTesterScoring } from "./tester-scoring.service";
import {
  SurveyValidationError,
  buildProfile,
  getActiveSurvey,
  validateAnswers,
  type SurveyAnswers,
} from "./tester-survey.service";

export interface TesterStats {
  activeTests: number;
  activeGames: string[];
  completedTests: number;
  completedHours: number;
  earnedBenefits: number;
  /** Đã trao + đang chờ trao. */
  usedBenefits: number;
  /** Phần của usedBenefits đang chờ PIC trao quà. */
  pendingBenefits: number;
  availableBenefits: number;
}

type AssignmentWithCampaign = {
  completed: boolean;
  workloadHours: number | null;
  campaign: { gameName: string; workloadHours: number; status: string };
};

/** Lượt đổi quà ở các trạng thái này trừ vào benefit; rejected/cancelled được hoàn lại. */
export const ACTIVE_REDEMPTION_STATUSES = ["pending", "fulfilled"];

export function redemptionTotals(rows: Array<{ amount: number; status: string }>): { used: number; pending: number } {
  let used = 0;
  let pending = 0;
  for (const r of rows) {
    if (!ACTIVE_REDEMPTION_STATUSES.includes(r.status)) continue;
    used += r.amount;
    if (r.status === "pending") pending += r.amount;
  }
  return { used, pending };
}

/** Benefit có = round(giờ test đã hoàn thành / 3) như cột All_benefit cũ. */
export function benefitUnits(hours: number): number {
  const per = testerConfig.workload().benefitHoursPerUnit || 3;
  return Math.round(hours / per);
}

export function assignmentHours(a: AssignmentWithCampaign): number {
  return a.workloadHours ?? a.campaign.workloadHours ?? 0;
}

export function statsFor(assignments: AssignmentWithCampaign[], used: number, pending = 0): TesterStats {
  const active = assignments.filter((a) => !a.completed && a.campaign.status !== "cancelled" && a.campaign.status !== "done");
  const done = assignments.filter((a) => a.completed);
  const completedHours = done.reduce((sum, a) => sum + assignmentHours(a), 0);
  const earned = benefitUnits(completedHours);
  return {
    activeTests: active.length,
    activeGames: [...new Set(active.map((a) => a.campaign.gameName))],
    completedTests: new Set(done.map((a) => a.campaign.gameName)).size,
    completedHours: Math.round(completedHours * 100) / 100,
    earnedBenefits: earned,
    usedBenefits: used,
    pendingBenefits: pending,
    availableBenefits: earned - used,
  };
}

function sanitizeAnswers(input: unknown): SurveyAnswers {
  const out: SurveyAnswers = {};
  if (!input || typeof input !== "object") return out;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!/^Q\d+(__other|__rows)?$/.test(key)) continue;
    if (typeof value === "string") out[key] = value.slice(0, 4000);
    else if (Array.isArray(value)) out[key] = value.filter((v): v is string => typeof v === "string").map((v) => v.slice(0, 500));
  }
  return out;
}

/** Dữ liệu cho landing page công khai /tester (không có tên người phụ trách phần quà). */
export async function testerPublicInfo() {
  const [testers, campaigns, completedTests] = await Promise.all([
    prismaApp.testerProfile.count({ where: { active: true, user: { roles: { has: "TESTER" } } } }),
    prismaApp.testCampaign.count({ where: { status: { not: "cancelled" } } }),
    prismaApp.testAssignment.count({ where: { completed: true } }),
  ]);
  const workload = testerConfig.workload();
  return {
    genres: testerConfig.genres().map((g) => ({ key: g.key, label: g.label })),
    benefitHoursPerUnit: workload.benefitHoursPerUnit,
    workload: workload.groups.map((g) => ({
      label: g.label,
      testDays: g.testDays,
      hoursPerDay: g.hoursPerDay,
      workloadHours: g.workloadHours,
    })),
    rewards: testerConfig.benefits().tiers.map((t) => ({
      condition: t.condition,
      items: t.items.map((i) => ({ game: i.game, reward: i.reward })),
    })),
    stats: { testers, campaigns, completedTests },
  };
}

export async function getTesterMe(user: AuthUserDto) {
  const [profile, latest, assignments, redemptions] = await Promise.all([
    prismaApp.testerProfile.findUnique({ where: { userId: user.id }, include: { genreScores: true } }),
    prismaApp.surveyResponse.findFirst({ where: { userId: user.id }, orderBy: { submittedAt: "desc" } }),
    prismaApp.testAssignment.findMany({ where: { userId: user.id }, include: { campaign: true } }),
    prismaApp.benefitRedemption.findMany({ where: { userId: user.id }, select: { amount: true, status: true } }),
  ]);
  const totals = redemptionTotals(redemptions);
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      role: user.role,
      roles: user.roles,
    },
    canManage: user.role === "SUPER_ADMIN" || user.permissions["tester.manage"] === true,
    hasSourcing: user.role !== "TESTER" && user.status === "ACTIVE",
    profile: profile
      ? {
          name: profile.name,
          office: profile.office,
          team: profile.team,
          ageRange: profile.ageRange,
          platforms: profile.platforms,
          gender: profile.gender,
          weeklyPlayLabel: profile.weeklyPlayLabel,
          weeklyPlayLevel: profile.weeklyPlayLevel,
          payLabel: profile.payLabel,
          payTier: profile.payTier,
          testTimeLabel: profile.testTimeLabel,
          favoriteGenre: profile.favoriteGenre,
          favoriteGenreLabel: profile.favoriteGenre ? genreLabel(profile.favoriteGenre) : null,
          genres: profile.genres,
          scoringStatus: profile.scoringStatus,
          scoredAt: profile.scoredAt?.toISOString() ?? null,
          genreScores: profile.genreScores
            .map((s) => ({
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
            }))
            .sort((a, b) => b.finalScore - a.finalScore),
        }
      : null,
    answers: (latest?.answers as SurveyAnswers | undefined) ?? null,
    submittedAt: latest?.submittedAt.toISOString() ?? null,
    stats: statsFor(assignments, totals.used, totals.pending),
  };
}

export async function submitTesterSurvey(
  user: AuthUserDto,
  body: { answers?: unknown; startedAt?: unknown; device?: unknown },
) {
  const form = await getActiveSurvey();
  const answers = sanitizeAnswers(body.answers);
  const issues = validateAnswers(form, answers);
  if (issues.length > 0) throw new SurveyValidationError(issues);

  const startedAt =
    typeof body.startedAt === "string" && !Number.isNaN(Date.parse(body.startedAt)) ? new Date(body.startedAt) : null;
  const response = await prismaApp.surveyResponse.create({
    data: {
      formId: form.id,
      formVersion: form.version,
      userId: user.id,
      answers,
      startedAt,
      durationSec: startedAt ? Math.max(0, Math.round((Date.now() - startedAt.getTime()) / 1000)) : null,
      device: typeof body.device === "string" ? body.device.slice(0, 40) : null,
    },
  });
  const fields = buildProfile(form, answers, user.name ?? user.email);
  await prismaApp.testerProfile.upsert({
    where: { userId: user.id },
    create: { userId: user.id, ...fields, responseId: response.id, scoringStatus: "pending" },
    update: { ...fields, responseId: response.id, scoringStatus: "pending" },
  });
  await ensureTesterRole(user.id);
  queueTesterScoring(user.id);
  return getTesterMe(user);
}

export async function myTests(userId: string) {
  const rows = await prismaApp.testAssignment.findMany({
    where: { userId },
    include: { campaign: true },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((a) => ({
    id: a.id,
    completed: a.completed,
    completedAt: a.completedAt?.toISOString() ?? null,
    workloadHours: assignmentHours(a),
    campaign: {
      id: a.campaign.id,
      gameName: a.campaign.gameName,
      appId: a.campaign.appId,
      iconUrl: a.campaign.iconUrl,
      genre: a.campaign.genre,
      platform: a.campaign.platform,
      startDate: a.campaign.startDate?.toISOString().slice(0, 10) ?? null,
      endDate: a.campaign.endDate?.toISOString().slice(0, 10) ?? null,
      status: a.campaign.status,
    },
  }));
}

export class BenefitRedeemError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Tháng ICT dạng YYYY-MM. */
function ictMonth(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit" }).format(d);
}

type MonthAssignment = AssignmentWithCampaign & {
  createdAt: Date;
  completedAt: Date | null;
  campaign: AssignmentWithCampaign["campaign"] & { endDate: Date | null };
};

/** Game và giờ test hoàn thành trong tháng hiện tại (theo ngày hoàn thành, thiếu thì ngày kết thúc đợt test). */
function monthActivity(assignments: MonthAssignment[], now = new Date()) {
  const month = ictMonth(now);
  const done = assignments.filter(
    (a) => a.completed && ictMonth(a.completedAt ?? a.campaign.endDate ?? a.createdAt) === month,
  );
  return {
    month,
    games: new Set(done.map((a) => a.campaign.gameName)).size,
    hours: Math.round(done.reduce((sum, a) => sum + assignmentHours(a), 0) * 100) / 100,
  };
}

type RedemptionRow = {
  id: string;
  amount: number;
  item: string;
  note: string | null;
  createdAt: Date;
  status: string;
  tier: number | null;
  game: string | null;
  reward: string | null;
  gameAccount: string | null;
  adminNote: string | null;
  processedAt: Date | null;
};

/** "A HOẶC B" trong benefits.json = tester chọn 1 trong các phương án. */
function rewardOptions(reward: string): string[] {
  return reward
    .split(/\s+HOẶC\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Catalog quà theo tier kèm luật đổi (redeem-rules.json) và lý do đang khóa, nếu có. */
function redeemTiers(month: ReturnType<typeof monthActivity>, redemptions: RedemptionRow[], available: number) {
  const rules = testerConfig.redeemRules().tiers;
  return testerConfig.benefits().tiers.map((tier, index) => {
    const rule = rules[index] ?? { cost: 1, monthlyLimit: null, requirement: null };
    const usedThisMonth = redemptions.filter(
      (r) => r.tier === index && ACTIVE_REDEMPTION_STATUSES.includes(r.status) && ictMonth(r.createdAt) === month.month,
    ).length;
    const req = rule.requirement;
    const meetsGames = req?.minGamesPerMonth != null && month.games >= req.minGamesPerMonth;
    const meetsHours = req?.minHoursPerMonth != null && month.hours >= req.minHoursPerMonth;
    let lockedReason: string | null = null;
    if (req && !meetsGames && !meetsHours) {
      const parts = [
        req.minGamesPerMonth != null ? `${req.minGamesPerMonth} game` : null,
        req.minHoursPerMonth != null ? `${req.minHoursPerMonth} giờ test` : null,
      ].filter(Boolean);
      lockedReason = `Cần hoàn thành ${parts.join(" hoặc ")} trong tháng (tháng này: ${month.games} game, ${month.hours} giờ)`;
    } else if (rule.monthlyLimit != null && usedThisMonth >= rule.monthlyLimit) {
      lockedReason = `Đã đổi ${usedThisMonth}/${rule.monthlyLimit} lần trong tháng này`;
    } else if (available < rule.cost) {
      lockedReason = `Cần ${rule.cost} benefit, bạn còn ${available}`;
    }
    return {
      index,
      condition: tier.condition,
      cost: rule.cost,
      monthlyLimit: rule.monthlyLimit,
      requirement: req,
      usedThisMonth,
      lockedReason,
      items: tier.items.map((it, i) => ({
        index: i,
        game: it.game,
        reward: it.reward,
        options: rewardOptions(it.reward),
        pic: it.pic,
      })),
    };
  });
}

function redemptionDto(r: RedemptionRow) {
  return {
    id: r.id,
    amount: r.amount,
    item: r.item,
    game: r.game,
    reward: r.reward,
    tier: r.tier,
    gameAccount: r.gameAccount,
    note: r.note,
    status: r.status,
    adminNote: r.adminNote,
    createdAt: r.createdAt.toISOString(),
    processedAt: r.processedAt?.toISOString() ?? null,
  };
}

export async function myBenefits(userId: string) {
  const [assignments, redemptions] = await Promise.all([
    prismaApp.testAssignment.findMany({ where: { userId }, include: { campaign: true } }),
    prismaApp.benefitRedemption.findMany({ where: { userId }, orderBy: { createdAt: "desc" } }),
  ]);
  const totals = redemptionTotals(redemptions);
  const stats = statsFor(assignments, totals.used, totals.pending);
  const month = monthActivity(assignments);
  return {
    stats,
    month,
    tiers: redeemTiers(month, redemptions, stats.availableBenefits),
    teamRequests: testerConfig.benefits().teamRequests,
    redemptions: redemptions.map(redemptionDto),
    benefitHoursPerUnit: testerConfig.workload().benefitHoursPerUnit,
  };
}

/** Tester tự đổi quà: tạo yêu cầu chờ PIC trao, trừ benefit ngay (hoàn lại nếu bị từ chối/hủy). */
export async function redeemBenefit(
  user: AuthUserDto,
  body: { tier?: unknown; item?: unknown; option?: unknown; gameAccount?: unknown; note?: unknown },
) {
  const tierIndex = Number(body.tier);
  const itemIndex = Number(body.item);
  const tier = Number.isInteger(tierIndex) ? testerConfig.benefits().tiers[tierIndex] : undefined;
  const item = tier && Number.isInteger(itemIndex) ? tier.items[itemIndex] : undefined;
  if (!tier || !item) throw new BenefitRedeemError("Phần quà không hợp lệ");
  const options = rewardOptions(item.reward);
  const reward = options.length > 1 ? options[Number(body.option ?? -1)] : item.reward;
  if (!reward) throw new BenefitRedeemError("Chọn 1 trong các phần quà");
  const gameAccount = String(body.gameAccount ?? "").trim();
  if (gameAccount.length < 2 || gameAccount.length > 120) {
    throw new BenefitRedeemError("Nhập tài khoản nhận quà (UID, tên nhân vật hoặc server)");
  }
  const note = String(body.note ?? "").trim().slice(0, 300) || null;

  await prismaApp.$transaction(async (tx) => {
    // Khóa theo tester: 2 yêu cầu gửi cùng lúc không trừ quá số benefit còn lại.
    await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtext(${user.id}))`;
    const assignments = await tx.testAssignment.findMany({ where: { userId: user.id }, include: { campaign: true } });
    const redemptions = await tx.benefitRedemption.findMany({ where: { userId: user.id } });
    const totals = redemptionTotals(redemptions);
    const stats = statsFor(assignments, totals.used, totals.pending);
    const view = redeemTiers(monthActivity(assignments), redemptions, stats.availableBenefits)[tierIndex]!;
    if (view.lockedReason) throw new BenefitRedeemError(view.lockedReason, 409);
    await tx.benefitRedemption.create({
      data: {
        userId: user.id,
        amount: view.cost,
        item: `${item.game}: ${reward}`,
        tier: tierIndex,
        game: item.game,
        reward,
        gameAccount,
        note,
        status: "pending",
        createdBy: user.email,
      },
    });
  });
  return myBenefits(user.id);
}

export async function cancelRedemption(user: AuthUserDto, id: string) {
  const r = await prismaApp.benefitRedemption.updateMany({
    where: { id, userId: user.id, status: "pending" },
    data: { status: "cancelled", processedBy: user.email, processedAt: new Date() },
  });
  if (r.count === 0) throw new BenefitRedeemError("Yêu cầu đã được xử lý, không hủy được", 409);
  return myBenefits(user.id);
}
