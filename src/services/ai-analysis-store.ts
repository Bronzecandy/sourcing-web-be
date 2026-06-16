import { prismaApp } from "../utils/prisma-app";
import type { AIAnalysisResult } from "../types";

const LIST_ALL_LIMIT = Math.max(
  50,
  parseInt(process.env.AI_ANALYSIS_LIST_LIMIT ?? "500", 10) || 500,
);

function rowToResult(row: { id: string; userId: string; payload: unknown }): AIAnalysisResult {
  const payload = row.payload as AIAnalysisResult;
  return { ...payload, analyzedByUserId: row.userId, analysisId: row.id };
}

export async function getAnalysisById(analysisId: string): Promise<AIAnalysisResult | null> {
  const row = await prismaApp.userAiAnalysis.findUnique({ where: { id: analysisId } });
  return row ? rowToResult(row) : null;
}

export async function getAnalysisByKey(
  appId: number,
  analyzedAtIso: string,
  userId?: string,
): Promise<AIAnalysisResult | null> {
  const analyzedAt = new Date(analyzedAtIso);
  if (Number.isNaN(analyzedAt.getTime())) return null;

  if (userId) {
    const row = await prismaApp.userAiAnalysis.findUnique({
      where: { userId_appId_analyzedAt: { userId, appId, analyzedAt } },
    });
    return row ? rowToResult(row) : null;
  }

  const row = await prismaApp.userAiAnalysis.findFirst({
    where: { appId, analyzedAt },
    orderBy: { createdAt: "desc" },
  });
  return row ? rowToResult(row) : null;
}

export async function listAllAnalyses(): Promise<AIAnalysisResult[]> {
  const rows = await prismaApp.userAiAnalysis.findMany({
    orderBy: { analyzedAt: "desc" },
    take: LIST_ALL_LIMIT,
  });
  return rows.map(rowToResult);
}

export async function listAnalysesForUser(userId: string): Promise<AIAnalysisResult[]> {
  const rows = await prismaApp.userAiAnalysis.findMany({
    where: { userId },
    orderBy: { analyzedAt: "desc" },
  });
  return rows.map(rowToResult);
}

export async function getLatestAnalysisForApp(appId: number): Promise<AIAnalysisResult | null> {
  const row = await prismaApp.userAiAnalysis.findFirst({
    where: { appId },
    orderBy: { analyzedAt: "desc" },
  });
  return row ? rowToResult(row) : null;
}

export async function getLatestAnalysisForUser(
  userId: string,
  appId: number,
): Promise<AIAnalysisResult | null> {
  const row = await prismaApp.userAiAnalysis.findFirst({
    where: { userId, appId },
    orderBy: { analyzedAt: "desc" },
  });
  return row ? rowToResult(row) : null;
}

export async function getAnalysisHistoryForApp(appId: number): Promise<AIAnalysisResult[]> {
  const rows = await prismaApp.userAiAnalysis.findMany({
    where: { appId },
    orderBy: { analyzedAt: "desc" },
  });
  return rows.map(rowToResult);
}

export async function getAnalysisHistoryForUser(
  userId: string,
  appId: number,
): Promise<AIAnalysisResult[]> {
  const rows = await prismaApp.userAiAnalysis.findMany({
    where: { userId, appId },
    orderBy: { analyzedAt: "desc" },
  });
  return rows.map(rowToResult);
}

export async function saveAnalysisForUser(
  userId: string,
  result: AIAnalysisResult,
): Promise<string> {
  const analyzedAt = new Date(result.analyzedAt);
  const row = await prismaApp.userAiAnalysis.create({
    data: {
      userId,
      appId: result.appId,
      analyzedAt,
      payload: result as object,
    },
  });
  return row.id;
}

export async function deleteAnalysisForUser(
  userId: string,
  appId: number,
  analyzedAtIso: string,
): Promise<boolean> {
  const analyzedAt = new Date(analyzedAtIso);
  try {
    await prismaApp.userAiAnalysis.delete({
      where: {
        userId_appId_analyzedAt: { userId, appId, analyzedAt },
      },
    });
    return true;
  } catch {
    return false;
  }
}

export async function deleteAllAnalysesForUser(userId: string, appId: number): Promise<number> {
  const res = await prismaApp.userAiAnalysis.deleteMany({
    where: { userId, appId },
  });
  return res.count;
}
