import { prisma } from "../utils/prisma";
import { pool } from "../utils/prisma";
import { getCachedOrFetch } from "../utils/cache";
import { withDbRetry } from "../utils/db-retry";
import { translateTag, translateTags } from "../utils/tag-translator";
import { translateText, translateVietnameseToEnglish } from "../utils/translator";
import type {
  RankingQuery,
  DashboardStats,
  GameListItem,
  TapTapRawApp,
} from "../types";
import { extractDeveloperPublisher } from "./analysis-context";
import type { RankingSegment } from "../types";
import {
  activeLaunchBoards,
  classifyLaunchCategory,
  hasLaunchedRank,
  launchedPriorityRank,
  primaryLaunchBoard,
  type AppRankRow,
} from "../utils/app-rank";
import {
  downloadCountFromRaw,
  releaseDateIsoFromRaw,
} from "../utils/taptap-raw-extract";

export type GameDetailRange =
  | { kind: "days"; days: number }
  | { kind: "range"; from: string; to: string };

function prismaRowToAppRankRow(r: {
  appId: number;
  date: Date;
  reserveAndroidRank: number | null;
  reserveIosRank: number | null;
  hotAndroidRank: number | null;
  hotIosRank: number | null;
  popAndroidRank: number | null;
  popIosRank: number | null;
  newAndroidRank: number | null;
  newIosRank: number | null;
  raw?: unknown;
}): AppRankRow {
  return {
    appId: r.appId,
    date: r.date,
    reserveAndroidRank: r.reserveAndroidRank,
    reserveIosRank: r.reserveIosRank,
    hotAndroidRank: r.hotAndroidRank,
    hotIosRank: r.hotIosRank,
    popAndroidRank: r.popAndroidRank,
    popIosRank: r.popIosRank,
    newAndroidRank: r.newAndroidRank,
    newIosRank: r.newIosRank,
    raw: r.raw,
  };
}

function extractGameInfo(
  raw: unknown,
  reserveAndroidRank: number | null,
  reserveIosRank: number | null,
  appId: number,
): GameListItem {
  const r = raw as TapTapRawApp | null;
  return {
    appId,
    title: r?.title ?? `App #${appId}`,
    iconUrl: r?.icon?.url ?? null,
    androidRank: reserveAndroidRank,
    iosRank: reserveIosRank,
    rating: r?.stat?.rating?.score ?? null,
    reviewCount: r?.stat?.review_count ?? null,
    fansCount: r?.stat?.fans_count ?? null,
    reserveCount: r?.stat?.reserve_count ?? null,
    downloadCount: downloadCountFromRaw(raw),
    releaseDate: releaseDateIsoFromRaw(raw),
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
              c."reserveAndroidRank" AS "currentRank",
              p."reserveAndroidRank" AS "prevRank",
              p."reserveAndroidRank" - c."reserveAndroidRank" AS change,
              c.raw->>'title' AS title,
              c.raw->'icon'->>'url' AS "iconUrl"
            FROM "AppRank" c
            JOIN "AppRank" p ON c."appId" = p."appId" AND p."date" = $2
            WHERE c."date" = $1
              AND c."reserveAndroidRank" IS NOT NULL
              AND p."reserveAndroidRank" IS NOT NULL
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
                 jsonb_array_elements(raw->'tags') AS t(value)
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

  private async getFullRankingList(
    platform: string,
    dateOverride?: string,
    segment: RankingSegment = "reserve",
  ) {
    const cacheKey = `ranking-full-${segment}-${platform}-${dateOverride ?? "latest"}`;
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

      const plat = platform as "combined" | "android" | "ios";
      const where: Record<string, unknown> = { date: dateFilter };

      if (segment === "launched") {
        where.OR = [
          { hotAndroidRank: { not: null } },
          { hotIosRank: { not: null } },
          { popAndroidRank: { not: null } },
          { popIosRank: { not: null } },
          { newAndroidRank: { not: null } },
          { newIosRank: { not: null } },
        ];
      } else if (platform === "android") {
        where.reserveAndroidRank = { not: null };
      } else if (platform === "ios") {
        where.reserveIosRank = { not: null };
      } else {
        where.OR = [
          { reserveAndroidRank: { not: null } },
          { reserveIosRank: { not: null } },
        ];
      }

      const allRows = await prisma.appRank.findMany({ where });

      let mappedRows: GameListItem[];
      if (segment === "launched") {
        mappedRows = allRows
          .filter((r) => hasLaunchedRank(r))
          .map((r) => {
            const rowForMeta = prismaRowToAppRankRow(r);
            const base = extractGameInfo(r.raw, null, null, r.appId);
            return {
              ...base,
              androidRank: launchedPriorityRank(rowForMeta, "android"),
              iosRank: launchedPriorityRank(rowForMeta, "ios"),
              primaryLaunchBoard: primaryLaunchBoard(rowForMeta, plat),
              launchBoardTags: activeLaunchBoards(rowForMeta, plat),
              launchCategory: classifyLaunchCategory(rowForMeta),
              hotAndroidRank: r.hotAndroidRank,
              hotIosRank: r.hotIosRank,
              popAndroidRank: r.popAndroidRank,
              popIosRank: r.popIosRank,
              newAndroidRank: r.newAndroidRank,
              newIosRank: r.newIosRank,
            };
          });
      } else {
        mappedRows = allRows.map((r) =>
          extractGameInfo(r.raw, r.reserveAndroidRank, r.reserveIosRank, r.appId),
        );
      }

      const sortRank = (g: GameListItem) => {
        if (platform === "combined") {
          return Math.min(g.androidRank ?? 99999, g.iosRank ?? 99999);
        }
        return (platform === "android" ? g.androidRank : g.iosRank) ?? 99999;
      };

      mappedRows.sort((a, b) => {
        const bestA = sortRank(a);
        const bestB = sortRank(b);
        if (bestA !== bestB) return bestA - bestB;
        if (platform === "combined") {
          const aFromAndroid =
            a.androidRank != null && (a.iosRank == null || a.androidRank <= a.iosRank);
          const bFromAndroid =
            b.androidRank != null && (b.iosRank == null || b.androidRank <= b.iosRank);
          if (aFromAndroid && !bFromAndroid) return -1;
          if (!aFromAndroid && bFromAndroid) return 1;
        }
        return 0;
      });

      return { rows: mappedRows, date: dateFilter.toISOString().split("T")[0] };
    });
  }

  async getRankings(query: RankingQuery) {
    const page = Math.max(1, parseInt(query.page || "1"));
    const limit = Math.min(200, Math.max(1, parseInt(query.limit || "50")));
    const skip = (page - 1) * limit;
    const platform = query.platform || "combined";
    const segment: RankingSegment = query.segment === "launched" ? "launched" : "reserve";

    const full = await this.getFullRankingList(platform, query.date, segment);

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

  async getGameDetail(
    appId: number,
    range: GameDetailRange = { kind: "days", days: 30 },
    contentLang: "vi" | "en" = "vi",
  ) {
    const cacheKey =
      range.kind === "days"
        ? `game-detail-${appId}-d${range.days}-${contentLang}`
        : `game-detail-${appId}-${range.from}_${range.to}-${contentLang}`;

    return getCachedOrFetch(cacheKey, async () => {
        const rankings =
          range.kind === "days"
            ? await prisma.appRank.findMany({
                where: { appId },
                orderBy: { date: "desc" },
                take: range.days,
              })
            : await prisma.appRank.findMany({
                where: {
                  appId,
                  date: {
                    gte: new Date(`${range.from}T00:00:00.000Z`),
                    lte: new Date(`${range.to}T23:59:59.999Z`),
                  },
                },
                orderBy: { date: "asc" },
              });

        if (rankings.length === 0) return null;

        const latest =
          range.kind === "days"
            ? rankings[0]
            : rankings[rankings.length - 1];
        const rawApp = latest.raw as TapTapRawApp | null;
        const { developerName, publisherName } = extractDeveloperPublisher(rawApp);

        const historyRows =
          range.kind === "days" ? [...rankings].reverse() : rankings;

        const history = historyRows.map(
          (r: {
            date: Date;
            reserveAndroidRank: number | null;
            reserveIosRank: number | null;
            raw: unknown;
          }) => {
            const rd = r.raw as TapTapRawApp | null;
            return {
              date: r.date.toISOString().split("T")[0],
              androidRank: r.reserveAndroidRank,
              iosRank: r.reserveIosRank,
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
          const distRows = await withDbRetry(
            () =>
              pool.query<{ star: number; cnt: number }>(
                `SELECT star, COUNT(*)::int AS cnt
             FROM (
               SELECT LEAST(5, GREATEST(1,
                 ROUND((regexp_match(raw::text, '"score"\\s*:\\s*([0-9]+(?:\\.[0-9]+)?)'))[1]::numeric)
               ))::int AS star
               FROM "AppReview"
               WHERE "appId" = $1
                 AND raw IS NOT NULL
                 AND raw::text ~ '"score"\\s*:\\s*[0-9]'
             ) s
             WHERE star BETWEEN 1 AND 5
             GROUP BY star
             ORDER BY star`,
                [appId],
              ),
            `game-detail-review-dist-${appId}`,
          );
          for (const r of distRows.rows) {
            const star = r.star;
            if (star >= 1 && star <= 5) {
              reviewDistribution[`${star}`] = (reviewDistribution[`${star}`] ?? 0) + r.cnt;
            }
          }
        } catch (err) {
          console.warn(
            `[game-detail] Review distribution query failed for appId ${appId}, skipping:`,
            (err as Error).message,
          );
        }

        return {
          appId,
          title: rawApp?.title ?? `App #${appId}`,
          iconUrl: rawApp?.icon?.url ?? null,
          bannerUrl: rawApp?.banner?.url ?? null,
          description,
          developerNote,
          developerName,
          publisherName,
          tags: translateTags(rawApp?.tags?.map((t) => t.value) ?? []),
          rating: rawApp?.stat?.rating?.score ?? null,
          latestScore: rawApp?.stat?.rating?.latest_score ?? null,
          voteInfo: rawApp?.stat?.vote_info ?? null,
          reviewCount: rawApp?.stat?.review_count ?? null,
          fansCount: rawApp?.stat?.fans_count ?? null,
          reserveCount: rawApp?.stat?.reserve_count ?? null,
          hitsTotal: rawApp?.stat?.hits_total ?? null,
          releaseDate: releaseDateIsoFromRaw(rawApp),
          isExclusive: rawApp?.is_exclusive ?? false,
          editorChoice: rawApp?.editor_choice ?? false,
          screenshots: rawApp?.screenshots?.map((s) => s.url) ?? [],
          platforms: rawApp?.supported_platforms?.map((p) => p.key) ?? [],
          androidRank: latest.reserveAndroidRank,
          iosRank: latest.reserveIosRank,
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
    const [rows, total] = await withDbRetry(
      () =>
        Promise.all([
          prisma.appReview.findMany({
            where: { appId },
            orderBy: { reviewAt: "desc" },
            skip,
            take: limit,
          }),
          prisma.appReview.count({ where: { appId } }),
        ]),
      `game-reviews-${appId}-p${page}`,
    );

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
      appIds.map((id) => this.getGameDetail(id, { kind: "days", days }))
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
               jsonb_array_elements(raw->'tags') AS t(value)
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
