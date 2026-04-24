import { prisma } from "../utils/prisma";
import { pool } from "../utils/prisma";
import { getCachedOrFetch } from "../utils/cache";
import { translateTag, translateTags } from "../utils/tag-translator";
import { translateText, translateVietnameseToEnglish } from "../utils/translator";
import type {
  RankingQuery,
  DashboardStats,
  GameListItem,
  TapTapRawApp,
} from "../types";

function extractGameInfo(
  raw: unknown,
  androidRank: number | null,
  iosRank: number | null,
  appId: number
): GameListItem {
  const r = raw as TapTapRawApp | null;
  return {
    appId,
    title: r?.title ?? `App #${appId}`,
    iconUrl: r?.icon?.url ?? null,
    androidRank,
    iosRank,
    rating: r?.stat?.rating?.score ?? null,
    reviewCount: r?.stat?.review_count ?? null,
    fansCount: r?.stat?.fans_count ?? null,
    reserveCount: r?.stat?.reserve_count ?? null,
    tags: translateTags(r?.tags?.map((t) => t.value) ?? []),
    isExclusive: r?.is_exclusive ?? false,
    editorChoice: r?.editor_choice ?? false,
  };
}

export class GameService {
  async getDashboardStats(): Promise<DashboardStats> {
    return getCachedOrFetch(
      "dashboard-stats",
      async () => {
        const [totalDataPoints, totalReviews, latestRankRow] =
          await Promise.all([
            prisma.appRank.count(),
            prisma.appReview.count(),
            prisma.appRank.findFirst({ orderBy: { date: "desc" } }),
          ]);

        const latestDate = latestRankRow?.date
          ? latestRankRow.date.toISOString().split("T")[0]
          : null;

        const distinctApps = await prisma.appRank.findMany({
          select: { appId: true },
          distinct: ["appId"],
        });
        const totalApps = distinctApps.length;

        const distinctDates = await prisma.appRank.findMany({
          select: { date: true },
          distinct: ["date"],
        });
        const dateCount = distinctDates.length;

        const topMovers: DashboardStats["topMovers"] = {
          gainers: [],
          losers: [],
        };

        if (latestDate) {
          const latest = new Date(latestDate);
          const previous = new Date(latest);
          previous.setDate(previous.getDate() - 1);

          const moversSQL = `
            SELECT
              c."appId",
              c."androidRank" AS "currentRank",
              p."androidRank" AS "prevRank",
              p."androidRank" - c."androidRank" AS change,
              c.raw->>'title' AS title,
              c.raw->'icon'->>'url' AS "iconUrl"
            FROM "AppRank" c
            JOIN "AppRank" p ON c."appId" = p."appId" AND p."date" = $2
            WHERE c."date" = $1
              AND c."androidRank" IS NOT NULL
              AND p."androidRank" IS NOT NULL
            ORDER BY change DESC
          `;
          const { rows: moverRows } = await pool.query(moversSQL, [latest, previous]);

          topMovers.gainers = moverRows.slice(0, 10).map((r: Record<string, unknown>) => ({
            appId: r.appId as number,
            title: (r.title as string) ?? `App #${r.appId}`,
            iconUrl: (r.iconUrl as string) ?? null,
            change: Number(r.change),
          }));
          topMovers.losers = moverRows.slice(-10).reverse().map((r: Record<string, unknown>) => ({
            appId: r.appId as number,
            title: (r.title as string) ?? `App #${r.appId}`,
            iconUrl: (r.iconUrl as string) ?? null,
            change: Number(r.change),
          }));
        }

        let tagDistribution: Array<{ tag: string; count: number }> = [];
        if (latestDate) {
          const tagSQL = `
            SELECT t.value->>'value' AS tag, COUNT(*)::int AS count
            FROM "AppRank",
                 json_array_elements(raw->'tags') AS t(value)
            WHERE "date" = $1
              AND raw IS NOT NULL
              AND raw->'tags' IS NOT NULL
            GROUP BY t.value->>'value'
            ORDER BY count DESC
            LIMIT 15
          `;
          const { rows: tagRows } = await pool.query(tagSQL, [new Date(latestDate)]);
          tagDistribution = (tagRows as Array<{ tag: string; count: number }>).map((r) => ({
            tag: translateTag(r.tag),
            count: r.count,
          }));
        }

        return {
          totalApps,
          totalDataPoints,
          totalReviews,
          latestDate,
          dateCount,
          topMovers,
          tagDistribution,
        };
      },
    );
  }

  private async getFullRankingList(platform: string, dateOverride?: string) {
    const cacheKey = `ranking-full-${platform}-${dateOverride ?? "latest"}`;
    return getCachedOrFetch(cacheKey, async () => {
      const dateFilter = dateOverride
        ? new Date(dateOverride)
        : (
            await prisma.appRank.findFirst({
              orderBy: { date: "desc" },
              select: { date: true },
            })
          )?.date;

      if (!dateFilter) return { rows: [] as GameListItem[], date: null as string | null };

      const where: Record<string, unknown> = { date: dateFilter };
      if (platform === "android") {
        where.androidRank = { not: null };
      } else if (platform === "ios") {
        where.iosRank = { not: null };
      } else {
        where.OR = [
          { androidRank: { not: null } },
          { iosRank: { not: null } },
        ];
      }

      const allRows = await prisma.appRank.findMany({ where });
      let mappedRows = allRows.map(
        (r: { appId: number; androidRank: number | null; iosRank: number | null; raw: unknown }) =>
          extractGameInfo(r.raw, r.androidRank, r.iosRank, r.appId)
      );

      if (platform === "combined") {
        mappedRows.sort((a, b) => {
          const bestA = Math.min(a.androidRank ?? 99999, a.iosRank ?? 99999);
          const bestB = Math.min(b.androidRank ?? 99999, b.iosRank ?? 99999);
          if (bestA !== bestB) return bestA - bestB;
          const aFromAndroid = a.androidRank != null && (a.iosRank == null || a.androidRank <= a.iosRank);
          const bFromAndroid = b.androidRank != null && (b.iosRank == null || b.androidRank <= b.iosRank);
          if (aFromAndroid && !bFromAndroid) return -1;
          if (!aFromAndroid && bFromAndroid) return 1;
          return 0;
        });
      } else {
        mappedRows.sort((a, b) => {
          const va = (platform === "android" ? a.androidRank : a.iosRank) ?? 99999;
          const vb = (platform === "android" ? b.androidRank : b.iosRank) ?? 99999;
          return va - vb;
        });
      }

      return { rows: mappedRows, date: dateFilter.toISOString().split("T")[0] };
    });
  }

  async getRankings(query: RankingQuery) {
    const page = Math.max(1, parseInt(query.page || "1"));
    const limit = Math.min(200, Math.max(1, parseInt(query.limit || "50")));
    const skip = (page - 1) * limit;
    const platform = query.platform || "combined";

    const full = await this.getFullRankingList(platform, query.date);

    if (!full.date) {
      return { data: [], total: 0, page, limit, totalPages: 0, date: null };
    }

    let filtered = full.rows;

    if (query.search) {
      const s = query.search.toLowerCase();
      filtered = filtered.filter((g) => g.title.toLowerCase().includes(s));
    }
    if (query.tag) {
      const t = query.tag;
      filtered = filtered.filter((g) => g.tags.includes(t));
    }

    if (query.order === "desc") {
      filtered = [...filtered].reverse();
    }

    const filteredTotal = filtered.length;
    const paged = filtered.slice(skip, skip + limit);

    return {
      data: paged,
      total: filteredTotal,
      page,
      limit,
      totalPages: Math.ceil(filteredTotal / limit),
      date: full.date,
    };
  }

  async getAvailableDates() {
    return getCachedOrFetch(
      "available-dates",
      async () => {
        const dates = await prisma.appRank.findMany({
          select: { date: true },
          distinct: ["date"],
          orderBy: { date: "desc" },
          take: 90,
        });
        return dates.map(
          (d: { date: Date }) => d.date.toISOString().split("T")[0]
        );
      }
    );
  }

  async getGameDetail(appId: number, days: number = 30, contentLang: "vi" | "en" = "vi") {
    return getCachedOrFetch(
      `game-detail-${appId}-${days}-${contentLang}`,
      async () => {
        const rankings = await prisma.appRank.findMany({
          where: { appId },
          orderBy: { date: "desc" },
          take: days,
        });

        if (rankings.length === 0) return null;

        const latest = rankings[0];
        const rawApp = latest.raw as TapTapRawApp | null;

        const history = rankings.map(
          (r: { date: Date; androidRank: number | null; iosRank: number | null; raw: unknown }) => {
            const rd = r.raw as TapTapRawApp | null;
            return {
              date: r.date.toISOString().split("T")[0],
              androidRank: r.androidRank,
              iosRank: r.iosRank,
              rating: rd?.stat?.rating?.score ?? null,
              reviewCount: rd?.stat?.review_count ?? null,
              fansCount: rd?.stat?.fans_count ?? null,
              reserveCount: rd?.stat?.reserve_count ?? null,
            };
          }
        );

        const [descriptionVi, developerNoteVi, actualReviewCount] = await Promise.all([
          translateText(rawApp?.description?.text ?? null, `desc-${appId}`),
          translateText(rawApp?.developer_note?.text ?? null, `devnote-${appId}`),
          prisma.appReview.count({ where: { appId } }),
        ]);

        const description =
          contentLang === "en" && descriptionVi
            ? await translateVietnameseToEnglish(descriptionVi, `desc-en-${appId}`)
            : descriptionVi;
        const developerNote =
          contentLang === "en" && developerNoteVi
            ? await translateVietnameseToEnglish(developerNoteVi, `devnote-en-${appId}`)
            : developerNoteVi;

        const reviewDistribution: Record<string, number> = {};
        try {
          const distRows = await pool.query<{ score: number; cnt: number }>(
            `SELECT (raw->'review'->'score')::text::numeric AS score, COUNT(*)::int AS cnt
             FROM "AppReview"
             WHERE "appId" = $1
               AND raw IS NOT NULL
               AND raw->'review' IS NOT NULL
               AND raw->'review'->'score' IS NOT NULL
             GROUP BY score
             ORDER BY score`,
            [appId]
          );
          for (const r of distRows.rows) {
            const star = Math.round(Number(r.score));
            if (star >= 1 && star <= 5) {
              reviewDistribution[`${star}`] = (reviewDistribution[`${star}`] ?? 0) + r.cnt;
            }
          }
        } catch (err) {
          console.warn(`[game-detail] Review distribution query failed for appId ${appId}, skipping`);
        }

        return {
          appId,
          title: rawApp?.title ?? `App #${appId}`,
          iconUrl: rawApp?.icon?.url ?? null,
          bannerUrl: rawApp?.banner?.url ?? null,
          description,
          developerNote,
          tags: translateTags(rawApp?.tags?.map((t) => t.value) ?? []),
          rating: rawApp?.stat?.rating?.score ?? null,
          latestScore: rawApp?.stat?.rating?.latest_score ?? null,
          voteInfo: rawApp?.stat?.vote_info ?? null,
          reviewCount: rawApp?.stat?.review_count ?? null,
          fansCount: rawApp?.stat?.fans_count ?? null,
          reserveCount: rawApp?.stat?.reserve_count ?? null,
          hitsTotal: rawApp?.stat?.hits_total ?? null,
          isExclusive: rawApp?.is_exclusive ?? false,
          editorChoice: rawApp?.editor_choice ?? false,
          screenshots: rawApp?.screenshots?.map((s) => s.url) ?? [],
          platforms: rawApp?.supported_platforms?.map((p) => p.key) ?? [],
          androidRank: latest.androidRank,
          iosRank: latest.iosRank,
          actualReviewCount,
          reviewDistribution,
          history,
        };
      }
    );
  }

  async getGameReviews(
    appId: number,
    page: number = 1,
    limit: number = 20
  ) {
    const skip = (page - 1) * limit;
    const [rows, total] = await Promise.all([
      prisma.appReview.findMany({
        where: { appId },
        orderBy: { reviewAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.appReview.count({ where: { appId } }),
    ]);

    const data = rows.map((r: { id: number; reviewId: string; raw: unknown; reviewAt: Date | null }) => {
      const raw = r.raw as Record<string, unknown> | null;
      const author = raw?.author as Record<string, unknown> | undefined;
      const user = author?.user as Record<string, unknown> | undefined;
      const contents = raw?.contents as Record<string, unknown> | undefined;
      return {
        id: r.id,
        reviewId: r.reviewId,
        userName: (user?.name as string) ?? "Anonymous",
        userAvatar: (user?.avatar as Record<string, unknown>)?.url as string | null ?? null,
        content: (contents?.text as string) ?? (raw?.sharing as Record<string, unknown>)?.description as string ?? "",
        score: (raw?.score as number) ?? null,
        upsCount: (raw?.ups_count as number) ?? 0,
        commentCount: (raw?.comment_count as number) ?? 0,
        reviewAt: r.reviewAt,
      };
    });

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async compareGames(appIds: number[], days: number = 30) {
    const results = await Promise.all(
      appIds.map((id) => this.getGameDetail(id, days))
    );
    return results.filter(Boolean);
  }

  async getTags(date?: string) {
    return getCachedOrFetch(
      `tags-${date ?? "latest"}`,
      async () => {
        const dateFilter = date
          ? new Date(date)
          : (
              await prisma.appRank.findFirst({
                orderBy: { date: "desc" },
                select: { date: true },
              })
            )?.date;

        if (!dateFilter) return [];

        const tagSQL = `
          SELECT t.value->>'value' AS name, COUNT(*)::int AS count
          FROM "AppRank",
               json_array_elements(raw->'tags') AS t(value)
          WHERE "date" = $1
            AND raw IS NOT NULL
            AND raw->'tags' IS NOT NULL
          GROUP BY t.value->>'value'
          ORDER BY count DESC
        `;
        const { rows } = await pool.query(tagSQL, [dateFilter]);
        const translated = new Map<string, number>();
        for (const r of rows as Array<{ name: string; count: number }>) {
          const en = translateTag(r.name);
          translated.set(en, (translated.get(en) ?? 0) + r.count);
        }
        return Array.from(translated.entries())
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count);
      }
    );
  }
}

export const gameService = new GameService();
