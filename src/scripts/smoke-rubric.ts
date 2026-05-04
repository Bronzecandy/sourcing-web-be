/**
 * Quick smoke: library resolver + rubric merge (no DB, no OpenAI).
 * Run from `be/`: npx tsx src/scripts/smoke-rubric.ts
 */
import assert from "node:assert/strict";
import { buildAnalysisContextFromRaw } from "../services/analysis-context";
import { getActiveCriteria, loadRubricManifest } from "../services/rubric-manifest";
import {
  matchStudioName,
  mergeRubricFromLlm,
  normalizeName,
  parseLlmRubricRows,
  resolveLibraryScores,
  scoreGenreFromTags,
} from "../services/rubric-merge";
import type { TapTapRawApp } from "../types";
import fs from "fs";
import path from "path";

function loadGenreFile(): Parameters<typeof scoreGenreFromTags>[1] {
  const p = path.join(process.cwd(), "data", "libraries", "genre-tiers.json");
  return JSON.parse(fs.readFileSync(p, "utf-8")) as Parameters<typeof scoreGenreFromTags>[1];
}
function loadStudioFile(): Parameters<typeof matchStudioName>[1] {
  const p = path.join(process.cwd(), "data", "libraries", "studio-tiers.json");
  return JSON.parse(fs.readFileSync(p, "utf-8")) as Parameters<typeof matchStudioName>[1];
}

const raw: TapTapRawApp = {
  id: 1,
  title: "Smoke",
  tags: [{ id: 1, value: "Card RPG" }],
  developer: { name: "Hoyoverse" },
  publisher: { name: "NetEase Game" },
};

const genreLib = loadGenreFile();
const studioLib = loadStudioFile();

assert.equal(normalizeName("  MIHOYO  "), "mihoyo");

const g = scoreGenreFromTags(["Card RPG"], genreLib);
assert.ok(g);
assert.equal(g!.score, 90);

const m = matchStudioName("Hoyoverse", studioLib);
assert.ok(m);
assert.equal(m!.score, 92);

const ctx = buildAnalysisContextFromRaw(1, "Smoke", null, raw);
const manifest = loadRubricManifest();
const active = getActiveCriteria(manifest, null);
const libEntries = resolveLibraryScores(ctx, manifest);
assert.equal(libEntries.length, 2);
const byId = new Map(libEntries.map((e) => [e.criterionId, e]));
assert.equal(byId.get("overview.genre")?.score, 90);
assert.equal(byId.get("overview.developer")?.score, 92);

const merged = mergeRubricFromLlm(manifest, active, libEntries, [], undefined, 50);
const crit = new Map(merged.criteria.map((c) => [c.id, c]));
assert.equal(crit.get("overview.genre")?.source, "library");
assert.equal(crit.get("overview.genre")?.score, 90);
assert.equal(crit.get("overview.developer")?.source, "library");
assert.equal(crit.get("overview.publisher"), undefined);

const parsed = parseLlmRubricRows({
  rubricCriteria: [
    {
      id: "gameplay.combat_loop",
      score: 70,
      reasoning: "ok",
      mentionCount: 3,
      strengths: ["Nhịp tốt"],
      weaknesses: ["Hơi lặp"],
    },
  ],
});
assert.equal(parsed.length, 1);
assert.equal(parsed[0]?.id, "gameplay.combat_loop");
assert.deepEqual(parsed[0]?.strengths, ["Nhịp tốt"]);

console.log("smoke-rubric: OK");
