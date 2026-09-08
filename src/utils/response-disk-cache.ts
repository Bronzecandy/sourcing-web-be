import fs from "fs/promises";
import path from "path";

const RESPONSE_CACHE_DIR = path.join(process.cwd(), "data", "response-cache");
const LEGACY_DISTRIBUTION_DIR = path.join(process.cwd(), "data", "distribution-cache");

export interface StoredCacheFile<T = unknown> {
  cacheKey: string;
  savedAt: string;
  data: T;
}

function safeFilename(cacheKey: string): string {
  return cacheKey.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json";
}

export function shouldPersistCacheKey(key: string): boolean {
  if (
    key.startsWith("potential-detail-") ||
    key.startsWith("potential-breakdown-") ||
    key.startsWith("distribution-cohort-") ||
    key.startsWith("app-rank-light-") ||
    key.startsWith("game-detail-")
  ) {
    return false;
  }
  return (
    key === "dashboard-stats" ||
    key === "available-dates" ||
    key.startsWith("distribution-overview-") ||
    key.startsWith("distribution-trends-") ||
    key.startsWith("distribution-meta-") ||
    key.startsWith("ranking-full-") ||
    key.startsWith("breakout-") ||
    key.startsWith("reserve-growth-") ||
    key.startsWith("tags-") ||
    /^potential-[^-]+-(reserve|launched)-(combined|android|ios)-\d+$/.test(key)
  );
}

async function readFileIfPresent(filePath: string): Promise<StoredCacheFile | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as StoredCacheFile;
    if (parsed?.cacheKey && parsed.data !== undefined) return parsed;
    return null;
  } catch {
    return null;
  }
}

export async function readDiskCacheEntry<T>(cacheKey: string): Promise<StoredCacheFile<T> | null> {
  const name = safeFilename(cacheKey);
  const fresh = await readFileIfPresent(path.join(RESPONSE_CACHE_DIR, name));
  if (fresh) return fresh as StoredCacheFile<T>;
  return (await readFileIfPresent(path.join(LEGACY_DISTRIBUTION_DIR, name))) as StoredCacheFile<T> | null;
}

export async function persistDiskCacheEntry(cacheKey: string, data: unknown): Promise<void> {
  if (!shouldPersistCacheKey(cacheKey)) return;
  try {
    await fs.mkdir(RESPONSE_CACHE_DIR, { recursive: true });
    const payload: StoredCacheFile = {
      cacheKey,
      savedAt: new Date().toISOString(),
      data,
    };
    await fs.writeFile(path.join(RESPONSE_CACHE_DIR, safeFilename(cacheKey)), JSON.stringify(payload), "utf8");
  } catch {
    /* non-fatal */
  }
}

async function loadDir(dir: string): Promise<StoredCacheFile[]> {
  const out: StoredCacheFile[] = [];
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return out;
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const parsed = await readFileIfPresent(path.join(dir, file));
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Load persisted API payloads (new dir + legacy distribution-cache). */
export async function loadAllDiskCacheEntries(): Promise<StoredCacheFile[]> {
  const [fresh, legacy] = await Promise.all([
    loadDir(RESPONSE_CACHE_DIR),
    loadDir(LEGACY_DISTRIBUTION_DIR),
  ]);
  const byKey = new Map<string, StoredCacheFile>();
  for (const entry of legacy) byKey.set(entry.cacheKey, entry);
  for (const entry of fresh) byKey.set(entry.cacheKey, entry);
  return [...byKey.values()];
}
