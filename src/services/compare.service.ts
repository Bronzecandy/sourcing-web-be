import { getCachedOrFetch } from "../utils/cache";
import type {
  AIAnalysisResult,
  CompareAnalysisSummary,
  CompareGameEntry,
  CompareOverview,
} from "../types";
import { gameService } from "./game.service";
import { rankingService } from "./ranking.service";
import { getLatestAnalysisForApp } from "./ai-analysis-store";

function toAnalysisSummary(analysis: AIAnalysisResult | null): CompareAnalysisSummary {
  if (!analysis) {
    return { available: false };
  }
  return {
    available: true,
    analyzedAt: analysis.analyzedAt,
    weightedScore: analysis.rubric?.aggregate.weightedScore ?? analysis.sentimentScore,
    band5: analysis.rubric?.aggregate.band5 ?? null,
    decision: analysis.rubric?.aggregate.decision ?? null,
    partRollups: analysis.rubric?.aggregate.partRollups ?? [],
    redFlagAtAGlance: analysis.redFlagAtAGlance ?? null,
  };
}

export class CompareService {
  async buildCompareOverview(
    appIds: number[],
    days: number = 30,
    platform: "combined" | "android" | "ios" = "combined",
  ): Promise<CompareOverview> {
    const sorted = [...appIds].sort((a, b) => a - b);
    const cacheKey = `compare-overview-${sorted.join("-")}-d${days}-${platform}`;

    return getCachedOrFetch(cacheKey, async () => {
      const entries = await Promise.all(
        appIds.map(async (appId) => {
          const [detail, potential, analysis] = await Promise.all([
            gameService.getGameDetail(appId, { kind: "days", days }),
            rankingService.getGamePotentialBreakdown(appId, days, platform),
            getLatestAnalysisForApp(appId),
          ]);
          if (!detail) return null;
          return {
            appId,
            detail,
            potential,
            analysisSummary: toAnalysisSummary(analysis),
          };
        }),
      );

      const games = entries.filter((e) => e != null) as CompareGameEntry[];
      return { appIds, days, platform, games };
    });
  }
}

export const compareService = new CompareService();
