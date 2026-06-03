import NodeCache from "node-cache";
import { withDbRetry } from "./db-retry";

const ONE_DAY = 86400;

export const cache = new NodeCache({
  stdTTL: ONE_DAY,
  checkperiod: 600,
  useClones: false,
});

let forceRefresh = false;

export function setForceRefresh(v: boolean) {
  forceRefresh = v;
}

export function getCachedOrFetch<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttl: number = ONE_DAY
): Promise<T> {
  if (!forceRefresh) {
    const cached = cache.get<T>(key);
    if (cached !== undefined) return Promise.resolve(cached);
  }

  return withDbRetry(() => fetcher(), `cache:${key}`).then((data) => {
    cache.set(key, data, ttl);
    return data;
  });
}
