import { Prisma } from "../../generated/prisma-app/client";
import { prismaApp } from "../utils/prisma-app";
import type { GameComparisonAI, SavedGameComparison } from "../types";

let compareTableMissingLogged = false;

function isUserAiCompareTableMissing(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2021" &&
    String(err.meta?.modelName ?? "").includes("UserAiCompare")
  );
}

function logCompareTableMissingOnce(): void {
  if (compareTableMissingLogged) return;
  compareTableMissingLogged = true;
  console.warn(
    "[ai-compare] Table UserAiCompare missing on app DB — run: npm run prisma:migrate:app",
  );
}

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

function ephemeralSaved(
  appIds: number[],
  comparedAt: Date,
  result: GameComparisonAI,
): SavedGameComparison {
  const sorted = [...appIds].sort((a, b) => a - b);
  return {
    compareId: `ephemeral-${compareAppIdsKey(sorted)}-${comparedAt.getTime()}`,
    appIds: sorted,
    comparedAt: comparedAt.toISOString(),
    comparison: result,
  };
}

export async function saveCompareResult(
  userId: string,
  appIds: number[],
  result: GameComparisonAI,
): Promise<SavedGameComparison> {
  const sorted = [...appIds].sort((a, b) => a - b);
  const comparedAt = new Date();
  try {
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
  } catch (err) {
    if (isUserAiCompareTableMissing(err)) {
      logCompareTableMissingOnce();
      return ephemeralSaved(sorted, comparedAt, result);
    }
    throw err;
  }
}

export async function getLatestCompareForAppIds(
  appIds: number[],
): Promise<SavedGameComparison | null> {
  const key = compareAppIdsKey(appIds);
  try {
    const row = await prismaApp.userAiCompare.findFirst({
      where: { appIdsKey: key },
      orderBy: { comparedAt: "desc" },
    });
    return row ? rowToSaved(row) : null;
  } catch (err) {
    if (isUserAiCompareTableMissing(err)) {
      logCompareTableMissingOnce();
      return null;
    }
    throw err;
  }
}

export async function getCompareHistoryForAppIds(
  appIds: number[],
  limit = 10,
): Promise<SavedGameComparison[]> {
  const key = compareAppIdsKey(appIds);
  try {
    const rows = await prismaApp.userAiCompare.findMany({
      where: { appIdsKey: key },
      orderBy: { comparedAt: "desc" },
      take: Math.min(Math.max(limit, 1), 30),
    });
    return rows.map(rowToSaved);
  } catch (err) {
    if (isUserAiCompareTableMissing(err)) {
      logCompareTableMissingOnce();
      return [];
    }
    throw err;
  }
}

export async function getCompareById(compareId: string): Promise<SavedGameComparison | null> {
  try {
    const row = await prismaApp.userAiCompare.findUnique({ where: { id: compareId } });
    return row ? rowToSaved(row) : null;
  } catch (err) {
    if (isUserAiCompareTableMissing(err)) {
      logCompareTableMissingOnce();
      return null;
    }
    throw err;
  }
}
