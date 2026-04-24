import translate from "google-translate-api-x";
import fs from "fs";
import path from "path";

const CACHE_FILE = path.join(process.cwd(), ".translation-cache.json");
const MIN_DELAY_MS = 450;
const MAX_RETRIES = 5;

/** Bumps cache namespace when translation target language changes. */
const CACHE_VER = "vi-en-v1";

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

export function stripHtml(html: string): string {
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

/** Single-string path: batch endpoint often rejects long / mixed text ("Partial Translation Request Fail"). */
const TRANSLATE_OPTS = {
  forceBatch: false,
  rejectOnPartialFail: false,
  fallbackBatch: true,
  tld: "com" as const,
};

async function callTranslateWithBackoff(
  plain: string,
  opts: { from: string; to: string },
  logKey: string,
): Promise<string> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const now = Date.now();
    const wait = Math.max(0, MIN_DELAY_MS - (now - lastCallTime));
    if (wait > 0) await sleep(wait);
    lastCallTime = Date.now();

    try {
      const res = await translate(plain, {
        ...TRANSLATE_OPTS,
        ...opts,
      } as Parameters<typeof translate>[1]);
      if (res.text && res.text.trim()) return res.text;
      throw new Error("Empty translation response");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const is429 = msg.includes("Too Many Requests") || msg.includes("429");
      const isPartialOrReject =
        msg.includes("Partial Translation") ||
        msg.includes("rejected by the server") ||
        msg.includes("invalid") ||
        msg.includes("Empty translation");
      if ((is429 || isPartialOrReject) && attempt < MAX_RETRIES) {
        const backoff = MIN_DELAY_MS * Math.pow(2, attempt);
        console.warn(
          `[translate] retry ${attempt}/${MAX_RETRIES} for ${logKey} in ${backoff}ms (${msg.slice(0, 80)}…)`,
        );
        await sleep(backoff);
        continue;
      }
      console.error(`[translate] Failed for ${logKey} after ${attempt} attempts:`, msg);
      return plain;
    }
  }
  return plain;
}

function versionedKey(cacheKey: string): string {
  return `${CACHE_VER}:${cacheKey}`;
}

const MAX_CHUNK_CHARS = 3200;

async function translateInChunks(
  plain: string,
  opts: { from: string; to: string },
  logKey: string,
): Promise<string> {
  if (plain.length <= MAX_CHUNK_CHARS) {
    return callTranslateWithBackoff(plain, opts, logKey);
  }

  const lines = plain.split("\n");
  const chunks: string[] = [];
  let cur = "";
  for (const line of lines) {
    const next = cur.length ? `${cur}\n${line}` : line;
    if (next.length > MAX_CHUNK_CHARS) {
      if (cur) chunks.push(cur);
      if (line.length > MAX_CHUNK_CHARS) {
        for (let i = 0; i < line.length; i += MAX_CHUNK_CHARS) {
          chunks.push(line.slice(i, i + MAX_CHUNK_CHARS));
        }
        cur = "";
      } else {
        cur = line;
      }
    } else {
      cur = next;
    }
  }
  if (cur) chunks.push(cur);

  const parts: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    parts.push(await callTranslateWithBackoff(chunks[i]!, opts, `${logKey}#${i + 1}/${chunks.length}`));
  }
  return parts.join("\n");
}

/**
 * Game description / developer note: prefer Vietnamese for the site default.
 * Chinese → vi; other languages → auto → vi.
 */
export async function translateText(
  text: string | null,
  cacheKey: string,
): Promise<string | null> {
  if (!text) return null;

  const plain = stripHtml(text).trim();
  if (!plain) return null;

  const key = versionedKey(cacheKey);
  if (diskCache[key]) return diskCache[key];

  let translated: string;
  if (isMostlyChinese(plain)) {
    translated = await translateInChunks(plain, { from: "zh-CN", to: "vi" }, cacheKey);
  } else {
    translated = await translateInChunks(plain, { from: "auto", to: "vi" }, cacheKey);
  }

  diskCache[key] = translated;
  debouncedSave();
  return translated;
}

/** Vietnamese → English (cached). Used when UI content language is English. */
export async function translateVietnameseToEnglish(
  text: string | null,
  cacheKey: string,
): Promise<string | null> {
  if (!text) return null;
  const plain = stripHtml(text).trim();
  if (!plain) return null;

  const key = versionedKey(`${cacheKey}:to-en`);
  if (diskCache[key]) return diskCache[key];

  const translated = await translateInChunks(plain, { from: "vi", to: "en" }, `${cacheKey}-en`);

  diskCache[key] = translated;
  debouncedSave();
  return translated;
}
