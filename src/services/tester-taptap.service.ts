import { prismaApp } from "../utils/prisma-app";
import { toPostgresIntAppId } from "../utils/pg-int-app-id";
import { fetchTapTapDetailRawViaProxy, searchTapTapApps } from "../utils/taptap-proxy-fetch";
import {
  fetchAppDetailRaw,
  normalizeTapTapSearchApp,
  parseAppIdFromInput,
  type TapTapRawApp,
  type TapTapSearchApp,
} from "./taptap-client.service";
import { translateTags } from "../utils/tag-translator";
import { knownGame } from "./radar-known";
import { testerConfig } from "./tester-config";
import { TesterAdminError } from "./tester-admin.service";

/** Game TapTap cho ô chọn game khi tạo đợt test, kèm gợi ý điền sẵn form. */
export interface CampaignGameOption extends TapTapSearchApp {
  titleEn: string | null;
  /** Tag TapTap dịch sang tiếng Anh (cùng thứ tự với `tags`). */
  tagsEn: string[];
  /** Nhà phát hành (hoặc nhà phát triển nếu không có). */
  developer: string | null;
  suggestion: {
    gameName: string;
    genre: string;
    platform: "MB" | "PC" | "CS" | null;
    mainTags: string[];
    secondaryTags: string[];
  };
}

/** Tag TapTap → dòng game tester: theo thứ tự tag trên TapTap, tag chung xếp sau tag cụ thể. */
export function genreTagsFor(tags: string[]): { mainTags: string[]; secondaryTags: string[] } {
  const map = testerConfig.taptapTags();
  const generic = new Set(map.generic.map((t) => t.toLowerCase()));
  const best = new Map<string, number>();
  tags.forEach((tag, i) => {
    const t = tag.toLowerCase();
    const score = i + (generic.has(t) ? 100 : 0);
    for (const [key, list] of Object.entries(map.genres)) {
      if (!list.some((x) => x.toLowerCase() === t)) continue;
      best.set(key, Math.min(best.get(key) ?? Infinity, score));
    }
  });
  const keys = [...best.entries()].sort((a, b) => a[1] - b[1]).map(([key]) => key);
  return { mainTags: keys.slice(0, 1), secondaryTags: keys.slice(1, 3) };
}

function platformFor(app: TapTapSearchApp): "MB" | "PC" | "CS" | null {
  if (app.platforms.length === 0) return app.console ? "CS" : "MB";
  if (app.platforms.some((p) => p === "android" || p === "ios")) return "MB";
  if (app.platforms.includes("pc")) return "PC";
  return app.console ? "CS" : null;
}

/** Tên EN + mô tả genre tiếng Việt đã có từ Radar (kỳ gần nhất có dữ liệu). */
async function radarInfo(appIds: number[]): Promise<Map<number, { titleEn: string | null; genre: string | null }>> {
  const rows = await prismaApp.radarRecapRow.findMany({
    where: { appId: { in: appIds.map(toPostgresIntAppId) } },
    orderBy: { date: "desc" },
    select: { appId: true, titleEn: true, payload: true },
  });
  const out = new Map<number, { titleEn: string | null; genre: string | null }>();
  for (const r of rows) {
    const prev = out.get(r.appId) ?? { titleEn: null, genre: null };
    const genre = (r.payload as { genre?: unknown } | null)?.genre;
    out.set(r.appId, {
      titleEn: prev.titleEn ?? (r.titleEn?.trim() || null),
      genre: prev.genre ?? (typeof genre === "string" && genre.trim() ? genre.trim() : null),
    });
  }
  return out;
}

async function toOptions(apps: TapTapSearchApp[]): Promise<CampaignGameOption[]> {
  const radar = await radarInfo(apps.map((a) => a.id)).catch(() => new Map());
  return apps.map((app) => {
    const fromRadar = radar.get(toPostgresIntAppId(app.id));
    const titleEn = knownGame(app.id)?.titleEn?.trim() || fromRadar?.titleEn || null;
    const developer =
      app.developers.find((d) => d.type === "publisher")?.name ?? app.developers[0]?.name ?? null;
    const tagsEn = translateTags(app.tags);
    return {
      ...app,
      titleEn,
      tagsEn,
      developer,
      suggestion: {
        gameName: titleEn ?? app.title,
        genre: fromRadar?.genre ?? tagsEn.slice(0, 4).join(", "),
        platform: platformFor(app),
        ...genreTagsFor(app.tags),
      },
    };
  });
}

/** Tìm game trên TapTap theo tên, link hoặc TapTap ID. */
export async function searchCampaignGames(q: string): Promise<CampaignGameOption[]> {
  const query = q.trim().slice(0, 100);
  if (!query) return [];
  const appId = parseAppIdFromInput(query);
  if (!appId) return toOptions(await searchTapTapApps(query, 10));

  const detail = (await fetchTapTapDetailRawViaProxy(appId)) ?? (await fetchAppDetailRaw(appId));
  if (!detail || typeof detail.title !== "string") {
    throw new TesterAdminError("Không tìm thấy game với TapTap ID này", 404);
  }
  const base = normalizeTapTapSearchApp({ ...(detail as TapTapRawApp), id: appId });
  // Chi tiết app không có nhà phát hành/nền tảng → tìm theo tên để lấy đủ.
  const byTitle = await searchTapTapApps(base.title, 10).catch(() => []);
  return toOptions([byTitle.find((a) => a.id === appId) ?? base]);
}
