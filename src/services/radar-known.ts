import fs from "fs";
import path from "path";

/** Tên EN / NPH / genre / video đã dùng trong report trước (data/radar/known-games.json, khóa = TapTap ID). */
export interface KnownGame {
  titleEn?: string;
  publisher?: string;
  genre?: string;
  videoUrl?: string;
}

let cache: Record<string, KnownGame> | null = null;

export function knownGame(appId: number): KnownGame | null {
  if (!cache) {
    try {
      const file = path.join(process.cwd(), "data", "radar", "known-games.json");
      cache = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, KnownGame>;
    } catch {
      cache = {};
    }
  }
  return cache[String(appId)] ?? null;
}
