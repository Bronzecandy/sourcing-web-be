import fs from "fs";
import path from "path";

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

let cached: RubricManifest | null = null;

function manifestPath(): string {
  return path.join(process.cwd(), "data", "rubric", "manifest.json");
}

export function loadRubricManifest(): RubricManifest {
  if (cached) return cached;
  const p = manifestPath();
  cached = JSON.parse(fs.readFileSync(p, "utf-8")) as RubricManifest;
  return cached;
}

export function getActiveCriteria(manifest: RubricManifest, genrePack: string | null): RubricCriterionDef[] {
  const pack = genrePack ?? manifest.genrePackDefault;
  return manifest.criteria.filter((c) => c.genrePack == null || c.genrePack === pack);
}
