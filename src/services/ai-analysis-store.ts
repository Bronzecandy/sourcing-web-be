import { prismaApp } from "../utils/prisma-app";
import type { AIAnalysisResult } from "../types";

function rowToResult(row: { payload: unknown }): AIAnalysisResult {
  return row.payload as AIAnalysisResult;
}

export async function listAnalysesForUser(userId: string): Promise<AIAnalysisResult[]> {
  const rows = await prismaApp.userAiAnalysis.findMany({
    where: { userId },
    orderBy: { analyzedAt: "desc" },
  });
  return rows.map(rowToResult);
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

export async function saveAnalysisForUser(userId: string, result: AIAnalysisResult): Promise<void> {
  const analyzedAt = new Date(result.analyzedAt);
  await prismaApp.userAiAnalysis.create({
    data: {
      userId,
      appId: result.appId,
      analyzedAt,
      payload: result as object,
    },
  });
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
