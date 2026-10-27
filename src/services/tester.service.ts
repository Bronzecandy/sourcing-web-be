import { prismaApp } from "../utils/prisma-app";
import type { AuthUserDto } from "../types/auth";
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
  usedBenefits: number;
  availableBenefits: number;
}

type AssignmentWithCampaign = {
  completed: boolean;
  workloadHours: number | null;
  campaign: { gameName: string; workloadHours: number; status: string };
};

/** Benefit có = round(giờ test đã hoàn thành / 3) như cột All_benefit cũ. */
export function benefitUnits(hours: number): number {
  const per = testerConfig.workload().benefitHoursPerUnit || 3;
  return Math.round(hours / per);
}

export function assignmentHours(a: AssignmentWithCampaign): number {
  return a.workloadHours ?? a.campaign.workloadHours ?? 0;
}

export function statsFor(assignments: AssignmentWithCampaign[], used: number): TesterStats {
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

export async function getTesterMe(user: AuthUserDto) {
  const [profile, latest, assignments, used] = await Promise.all([
    prismaApp.testerProfile.findUnique({ where: { userId: user.id }, include: { genreScores: true } }),
    prismaApp.surveyResponse.findFirst({ where: { userId: user.id }, orderBy: { submittedAt: "desc" } }),
    prismaApp.testAssignment.findMany({ where: { userId: user.id }, include: { campaign: true } }),
    prismaApp.benefitRedemption.aggregate({ where: { userId: user.id }, _sum: { amount: true } }),
  ]);
  return {
    user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl, role: user.role },
    canManage: user.role === "SUPER_ADMIN" || user.permissions["tester.manage"] === true,
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
    stats: statsFor(assignments, used._sum.amount ?? 0),
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
      genre: a.campaign.genre,
      platform: a.campaign.platform,
      startDate: a.campaign.startDate?.toISOString().slice(0, 10) ?? null,
      endDate: a.campaign.endDate?.toISOString().slice(0, 10) ?? null,
      status: a.campaign.status,
    },
  }));
}

export async function myBenefits(userId: string) {
  const [assignments, redemptions] = await Promise.all([
    prismaApp.testAssignment.findMany({ where: { userId }, include: { campaign: true } }),
    prismaApp.benefitRedemption.findMany({ where: { userId }, orderBy: { createdAt: "desc" } }),
  ]);
  const used = redemptions.reduce((sum, r) => sum + r.amount, 0);
  return {
    stats: statsFor(assignments, used),
    redemptions: redemptions.map((r) => ({
      id: r.id,
      amount: r.amount,
      item: r.item,
      note: r.note,
      createdAt: r.createdAt.toISOString(),
    })),
    catalog: testerConfig.benefits(),
    benefitHoursPerUnit: testerConfig.workload().benefitHoursPerUnit,
  };
}
