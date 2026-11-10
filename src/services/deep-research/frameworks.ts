import fs from "fs";
import path from "path";
import type { FrameworkPattern, MetricUnit } from "./types";

export interface MetricDef {
  label: string;
  labelEn: string;
  unit: MetricUnit;
  kind: "percentile" | "growth" | "stability";
}

interface FrameworkFile {
  version: number;
  metrics: Record<string, MetricDef>;
  patterns: FrameworkPattern[];
}

const FILE = path.join(process.cwd(), "data", "deep-research", "genre-frameworks.json");
let loaded: { mtime: number; data: FrameworkFile } | null = null;

export function frameworks(): FrameworkFile {
  const mtime = fs.statSync(FILE).mtimeMs;
  if (!loaded || loaded.mtime !== mtime) {
    loaded = { mtime, data: JSON.parse(fs.readFileSync(FILE, "utf8")) as FrameworkFile };
  }
  return loaded.data;
}

/** Subgenre beats genre beats class; falls back to the pattern with an empty matcher. */
export function matchPattern(taxonomy: { class?: string | null; genre?: string | null; subgenre?: string | null }): FrameworkPattern {
  const { patterns } = frameworks();
  const has = (list: string[] | undefined, value: string | null | undefined) => Boolean(value && list?.includes(value));
  return (
    patterns.find((p) => has(p.match.subgenres, taxonomy.subgenre)) ??
    patterns.find((p) => has(p.match.genres, taxonomy.genre)) ??
    patterns.find((p) => has(p.match.classes, taxonomy.class)) ??
    patterns.find((p) => !p.match.subgenres && !p.match.genres && !p.match.classes) ??
    patterns[patterns.length - 1]
  );
}
