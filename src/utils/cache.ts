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

export function cacheHas(key: string): boolean {
  return cache.get(key) !== undefined;
}

const inflight = new Map<string, Promise<unknown>>();

export function getCachedOrFetch<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttl: number = ONE_DAY,
  retry?: { maxAttempts?: number; delayMs?: number },
): Promise<T> {
  if (!forceRefresh) {
    const cached = cache.get<T>(key);
    if (cached !== undefined) return Promise.resolve(cached);
  }

  const pending = inflight.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  const promise = withDbRetry(() => fetcher(), `cache:${key}`, retry)
    .then((data) => {
      cache.set(key, data, ttl);
      return data;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, promise);
  return promise;
}
