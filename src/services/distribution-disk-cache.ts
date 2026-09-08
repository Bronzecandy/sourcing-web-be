import { loadResponseDiskCache } from "../utils/cache";
import { persistDiskCacheEntry } from "../utils/response-disk-cache";
import type { DistributionOverviewResponse } from "../types";

/** @deprecated use loadResponseDiskCache — kept so existing imports keep working. */
export async function loadDistributionDiskCache(): Promise<number> {
  return loadResponseDiskCache();
}

/** @deprecated persist is automatic via getCachedOrFetch for overview/trends keys. */
export async function persistDistributionOverview(
  cacheKey: string,
  data: DistributionOverviewResponse,
): Promise<void> {
  await persistDiskCacheEntry(cacheKey, data);
}
