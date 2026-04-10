import translate from "google-translate-api-x";
import fs from "fs";
import path from "path";

const CACHE_FILE = path.join(process.cwd(), ".translation-cache.json");
const MIN_DELAY_MS = 300;
const MAX_RETRIES = 3;

let diskCache: Record<string, string> = {};

function loadDiskCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      diskCache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
      console.log(`[translate] Loaded ${Object.keys(diskCache).length} cached translations from disk`);
    }
  } catch {
    diskCache = {};
  }
}

function saveDiskCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(diskCache, null, 2), "utf-8");
  } catch (err) {
    console.error("[translate] Failed to save cache:", err);
  }
}

loadDiskCache();

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDiskCache, 5000);
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function isMostlyChinese(text: string): boolean {
  const cleaned = text.replace(/[\s\d\p{P}]/gu, "");
  if (cleaned.length === 0) return false;
  const cjk = cleaned.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g);
  return (cjk?.length ?? 0) / cleaned.length > 0.3;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let lastCallTime = 0;

export async function translateText(
  text: string | null,
  cacheKey: string
): Promise<string | null> {
  if (!text) return null;

  const plain = stripHtml(text).trim();
  if (!plain) return null;

  if (!isMostlyChinese(plain)) return plain;

  if (diskCache[cacheKey]) return diskCache[cacheKey];

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const now = Date.now();
    const wait = Math.max(0, MIN_DELAY_MS - (now - lastCallTime));
    if (wait > 0) await sleep(wait);
    lastCallTime = Date.now();

    try {
      const res = await translate(plain, { from: "zh-CN", to: "en" });
      const translated = res.text;
      diskCache[cacheKey] = translated;
      debouncedSave();
      return translated;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const is429 = msg.includes("Too Many Requests") || msg.includes("429");
      if (is429 && attempt < MAX_RETRIES) {
        const backoff = MIN_DELAY_MS * Math.pow(3, attempt);
        console.warn(`[translate] 429 for ${cacheKey}, retry ${attempt}/${MAX_RETRIES} in ${backoff}ms`);
        await sleep(backoff);
        continue;
      }
      console.error(`[translate] Failed for ${cacheKey} after ${attempt} attempts:`, msg);
      return plain;
    }
  }

  return plain;
}
