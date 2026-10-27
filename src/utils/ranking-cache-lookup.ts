import { cache } from "./cache";
import type { GameListItem } from "../types";

export function findCachedRankingGame(appId: number): GameListItem | null {
  const keys = cache.keys().filter((k) => k.startsWith("ranking-full-"));
  const preferred = keys.filter((k) => k.includes("-combined-"));
  const ordered = [...preferred, ...keys.filter((k) => !preferred.includes(k))];
  for (const key of ordered) {
    const val = cache.get<{ rows?: GameListItem[] }>(key);
    const hit = val?.rows?.find((r) => r.appId === appId);
    if (hit) return hit;
  }
  return null;
}
