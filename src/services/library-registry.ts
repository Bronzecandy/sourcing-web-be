import path from "path";

/** Whitelist of editable JSON files under data/libraries/ */
export const LIBRARY_FILES = [
  "genre-tiers.json",
  "studio-tiers.json",
  "game-size-tiers.json",
  "update-cycle-tiers.json",
  "community-size-tiers.json",
  "ip-theme-tiers.json",
  "system-requirement-tiers.json",
  "art-style-keywords.json",
  "pending-additions.json",
] as const;

export type LibraryFileId = (typeof LIBRARY_FILES)[number];

export function librariesDir(): string {
  return path.join(process.cwd(), "data", "libraries");
}

export function libraryFilePath(id: string): string {
  if (!LIBRARY_FILES.includes(id as LibraryFileId)) {
    throw new Error(`Unknown library file: ${id}`);
  }
  return path.join(librariesDir(), id);
}
