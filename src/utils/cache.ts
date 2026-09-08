import NodeCache from "node-cache";
import { withDbRetry } from "./db-retry";
import {
  loadAllDiskCacheEntries,
  persistDiskCacheEntry,
  readDiskCacheEntry,
  shouldPersistCacheKey,
} from "./response-disk-cache";

const ONE_DAY = 86400;
/** Recompute persisted keys in the background once they are older than this. */
const DISK_REFRESH_AFTER_MS = 12 * 60 * 60 * 1000;

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

/** Drop intermediate cache entries (e.g. cohort maps) to free RAM during heavy precompute. */
export function pruneCacheKeyPrefix(prefix: string): number {
  let n = 0;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.del(key);
      n += 1;
    }
  }
  return n;
}

const inflight = new Map<string, Promise<unknown>>();
const backgroundRefresh = new Set<string>();

function persistTtl(key: string, ttl: number): number {
  return shouldPersistCacheKey(key) ? 0 : ttl;
}

async function runFetch<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttl: number,
  retry?: { maxAttempts?: number; delayMs?: number },
): Promise<T> {
  const data = await withDbRetry(() => fetcher(), `cache:${key}`, retry);
  cache.set(key, data, persistTtl(key, ttl));
  void persistDiskCacheEntry(key, data);
  return data;
}

function scheduleBackgroundRefresh<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttl: number,
  retry?: { maxAttempts?: number; delayMs?: number },
): void {
  if (backgroundRefresh.has(key)) return;
  backgroundRefresh.add(key);
  void runFetch(key, fetcher, ttl, retry ?? { maxAttempts: 2, delayMs: 1500 })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[cache] background refresh failed ${key}: ${message}`);
    })
    .finally(() => {
      backgroundRefresh.delete(key);
    });
}

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

  const promise = (async () => {
    if (!forceRefresh && shouldPersistCacheKey(key)) {
      const disk = await readDiskCacheEntry<T>(key);
      if (disk) {
        cache.set(key, disk.data, persistTtl(key, ttl));
        const age = Date.now() - Date.parse(disk.savedAt);
        if (!Number.isFinite(age) || age >= DISK_REFRESH_AFTER_MS) {
          scheduleBackgroundRefresh(key, fetcher, ttl, retry);
        }
        return disk.data;
      }
    }

    try {
      return await runFetch(key, fetcher, ttl, retry);
    } catch (err) {
      const disk = await readDiskCacheEntry<T>(key);
      if (disk) {
        cache.set(key, disk.data, persistTtl(key, ttl));
        console.warn(`[cache] serving stale disk for ${key} after fetch error`);
        return disk.data;
      }
      throw err;
    }
  })().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, promise);
  return promise;
}

export async function loadResponseDiskCache(): Promise<number> {
  const entries = await loadAllDiskCacheEntries();
  for (const entry of entries) {
    cache.set(entry.cacheKey, entry.data, 0);
  }
  return entries.length;
}
