/**
 * Smoke test: multi-genre pack inference + criteria union (no LLM).
 * Run: npx tsx src/scripts/smoke-genre-packs.ts
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { inferAllGenrePacks, inferGenrePack } from "../services/library-resolve";
import { getActiveCriteria, getActiveCriteriaForPacks, type RubricManifest } from "../services/rubric-manifest";
import { normalizeGenrePackPlan } from "../services/genre-pack-inference";
import { mergeRubricFromLlm } from "../services/rubric-merge";

function loadManifestFromDisk(): RubricManifest {
  const p = path.join(__dirname, "../../data/rubric/manifest.json");
  return JSON.parse(fs.readFileSync(p, "utf8")) as RubricManifest;
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const deltaTags = ["Shooter", "Extraction", "Delta Force", "FPS"];
const all = inferAllGenrePacks(deltaTags);
console.log("inferAllGenrePacks(Delta Force tags):", all);
assert(all.includes("extraction"), "expected extraction");
assert(all.includes("shooter"), "expected shooter");
assert(inferGenrePack(deltaTags) === "extraction", "inferGenrePack priority = extraction first");

const manifest = loadManifestFromDisk();
const single = getActiveCriteria(manifest, "extraction");
const multi = getActiveCriteriaForPacks(manifest, ["extraction", "shooter"]);
const singleGenre = single.filter((c) => c.genrePack != null).length;
const multiGenre = multi.filter((c) => c.genrePack != null).length;
console.log(`genre criteria: single=${singleGenre} multi=${multiGenre}`);
assert(multiGenre > singleGenre, "multi pack should include more genre criteria");
assert(multi.length >= single.length, "multi criteria count >= single");

const plan = normalizeGenrePackPlan(
  {
    packs: [
      { packId: "extraction", weight: 0.7 },
      { packId: "shooter", weight: 0.3 },
    ],
    reasoning: "test",
    ratioPreset: "7:3",
  },
  manifest,
);
assert(Math.abs(plan.packs[0].weight - 0.7) < 0.01, "weight 70%");
assert(plan.packs.length === 2, "two packs");

const mockLlmRows = multi
  .filter((c) => c.partId !== "red_flag")
  .map((c) => ({
    id: c.id,
    score: 60,
    reasoning: "smoke",
  }));

const rubric = mergeRubricFromLlm(manifest, multi, [], mockLlmRows, {}, 50, plan);
assert(rubric.genrePacksResolved?.length === 2, "stored genrePacksResolved");
assert(rubric.genrePackRollups?.length === 2, "genrePackRollups per pack");
assert(rubric.aggregate.weightedScore != null, "weighted score computed");
const gameplayW = rubric.aggregate.partRollups?.find((r) => r.partId === "gameplay")?.weightInTotal;
const genreW = rubric.aggregate.partRollups?.find((r) => r.partId === "genre_specific")?.weightInTotal;
assert(gameplayW === 0.1, `gameplay weight 10% got ${gameplayW}`);
assert(genreW === 0.3, `genre weight 30% got ${genreW}`);
console.log("weightedScore:", rubric.aggregate.weightedScore);
console.log("genrePackResolved:", rubric.genrePackResolved);

console.log("smoke-genre-packs: OK");
