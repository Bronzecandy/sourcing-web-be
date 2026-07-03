import { prismaApp } from "../utils/prisma-app";
import type { GameComparisonAI, SavedGameComparison } from "../types";

export function compareAppIdsKey(appIds: number[]): string {
  return [...appIds].sort((a, b) => a - b).join(",");
}

function rowToSaved(row: {
  id: string;
  appIds: unknown;
  comparedAt: Date;
  payload: unknown;
}): SavedGameComparison {
  const appIds = row.appIds as number[];
  return {
    compareId: row.id,
    appIds,
    comparedAt: row.comparedAt.toISOString(),
    comparison: row.payload as GameComparisonAI,
  };
}

export async function saveCompareResult(
  userId: string,
  appIds: number[],
  result: GameComparisonAI,
): Promise<SavedGameComparison> {
  const sorted = [...appIds].sort((a, b) => a - b);
  const comparedAt = new Date();
  const row = await prismaApp.userAiCompare.create({
    data: {
      userId,
      appIdsKey: compareAppIdsKey(sorted),
      appIds: sorted,
      comparedAt,
      payload: result as object,
    },
  });
  return rowToSaved(row);
}

export async function getLatestCompareForAppIds(
  appIds: number[],
): Promise<SavedGameComparison | null> {
  const key = compareAppIdsKey(appIds);
  const row = await prismaApp.userAiCompare.findFirst({
    where: { appIdsKey: key },
    orderBy: { comparedAt: "desc" },
  });
  return row ? rowToSaved(row) : null;
}

export async function getCompareHistoryForAppIds(
  appIds: number[],
  limit = 10,
): Promise<SavedGameComparison[]> {
  const key = compareAppIdsKey(appIds);
  const rows = await prismaApp.userAiCompare.findMany({
    where: { appIdsKey: key },
    orderBy: { comparedAt: "desc" },
    take: Math.min(Math.max(limit, 1), 30),
  });
  return rows.map(rowToSaved);
}

export async function getCompareById(compareId: string): Promise<SavedGameComparison | null> {
  const row = await prismaApp.userAiCompare.findUnique({ where: { id: compareId } });
  return row ? rowToSaved(row) : null;
}
