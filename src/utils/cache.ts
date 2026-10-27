import { AsyncLocalStorage } from "node:async_hooks";
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

/**
 * Cron/warm-up rebuilds must not skip RAM/disk for *user* requests.
 * `withForceRefresh` marks only the current async call tree as a recompute.
 */
const recomputeAls = new AsyncLocalStorage<{ recompute: boolean }>();

/** Kept for scripts; request serving ignores this process-wide flag. */
export function setForceRefresh(_v: boolean) {
  /* no-op: use withForceRefresh() so user traffic still hits RAM/disk */
}

export function withForceRefresh<T>(fn: () => Promise<T>): Promise<T> {
  return recomputeAls.run({ recompute: true }, fn);
}

function isRecompute(): boolean {
  return recomputeAls.getStore()?.recompute === true;
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

function startInflightFetch<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttl: number,
  retry?: { maxAttempts?: number; delayMs?: number },
): Promise<T> {
  const pending = inflight.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  const staleMemory = cache.get<T>(key);
  const promise = (async () => {
    try {
      return await runFetch(key, fetcher, ttl, retry);
    } catch (err) {
      if (staleMemory !== undefined) {
        cache.set(key, staleMemory, persistTtl(key, ttl));
        console.warn(`[cache] serving stale memory for ${key} after fetch error`);
        return staleMemory;
      }
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

export function getCachedOrFetch<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttl: number = ONE_DAY,
  retry?: { maxAttempts?: number; delayMs?: number },
): Promise<T> {
  const recompute = isRecompute();
  const cached = cache.get<T>(key);

  // User / request path: never wait on cron DB if RAM (or disk) already has a payload.
  if (!recompute && cached !== undefined) {
    return Promise.resolve(cached);
  }

  if (!recompute && shouldPersistCacheKey(key)) {
    return (async () => {
      const ram = cache.get<T>(key);
      if (ram !== undefined) return ram;
      const disk = await readDiskCacheEntry<T>(key);
      if (disk) {
        cache.set(key, disk.data, persistTtl(key, ttl));
        const age = Date.now() - Date.parse(disk.savedAt);
        if (!Number.isFinite(age) || age >= DISK_REFRESH_AFTER_MS) {
          scheduleBackgroundRefresh(key, fetcher, ttl, retry);
        }
        return disk.data;
      }
      return startInflightFetch(key, fetcher, ttl, retry);
    })();
  }

  return startInflightFetch(key, fetcher, ttl, retry);
}

export async function loadResponseDiskCache(): Promise<number> {
  const entries = await loadAllDiskCacheEntries();
  for (const entry of entries) {
    cache.set(entry.cacheKey, entry.data, 0);
  }
  return entries.length;
}
