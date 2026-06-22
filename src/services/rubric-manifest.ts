import { getRubricManifest, getRubricManifestSync } from "./library-store";

export interface RubricManifestPart {
  id: string;
  labelVi: string;
  weight: number;
}

export interface RubricCriterionDef {
  id: string;
  partId: string;
  elementVi: string;
  input: string;
  weightInPart: number;
  genrePack: string | null;
  promptHint: string;
}

export interface RubricManifest {
  version: number;
  genrePackDefault: string | null;
  parts: RubricManifestPart[];
  criteria: RubricCriterionDef[];
}

export function loadRubricManifest(): RubricManifest {
  return getRubricManifestSync();
}

export async function loadRubricManifestAsync(): Promise<RubricManifest> {
  return getRubricManifest();
}

export function getActiveCriteria(manifest: RubricManifest, genrePack: string | null): RubricCriterionDef[] {
  const pack = genrePack ?? manifest.genrePackDefault;
  return manifest.criteria.filter((c) => c.genrePack == null || c.genrePack === pack);
}

/** Union tiêu chí shared + genre của tất cả pack đã chọn. */
export function getActiveCriteriaForPacks(manifest: RubricManifest, packIds: string[]): RubricCriterionDef[] {
  const packs = new Set(packIds.filter((id) => id && id !== "base"));
  if (packs.size === 0) {
    return getActiveCriteria(manifest, "base");
  }
  const seen = new Set<string>();
  const out: RubricCriterionDef[] = [];
  for (const c of manifest.criteria) {
    if (c.genrePack == null || packs.has(c.genrePack)) {
      if (!seen.has(c.id)) {
        seen.add(c.id);
        out.push(c);
      }
    }
  }
  return out;
}
