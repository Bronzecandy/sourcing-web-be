import fs from "fs/promises";
import path from "path";
import { cache } from "../utils/cache";
import type { DistributionOverviewResponse } from "../types";

const CACHE_DIR = path.join(process.cwd(), "data", "distribution-cache");

interface StoredOverviewFile {
  cacheKey: string;
  savedAt: string;
  data: DistributionOverviewResponse;
}

function safeFilename(cacheKey: string): string {
  return cacheKey.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json";
}

export async function loadDistributionDiskCache(): Promise<number> {
  let loaded = 0;
  try {
    const files = await fs.readdir(CACHE_DIR);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(CACHE_DIR, file), "utf8");
        const parsed = JSON.parse(raw) as StoredOverviewFile;
        if (parsed.cacheKey && parsed.data) {
          cache.set(parsed.cacheKey, parsed.data);
          loaded += 1;
        }
      } catch {
        /* skip corrupt file */
      }
    }
  } catch {
    /* dir missing */
  }
  return loaded;
}

export async function persistDistributionOverview(
  cacheKey: string,
  data: DistributionOverviewResponse,
): Promise<void> {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    const payload: StoredOverviewFile = {
      cacheKey,
      savedAt: new Date().toISOString(),
      data,
    };
    await fs.writeFile(path.join(CACHE_DIR, safeFilename(cacheKey)), JSON.stringify(payload), "utf8");
  } catch {
    /* non-fatal */
  }
}
