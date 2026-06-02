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
