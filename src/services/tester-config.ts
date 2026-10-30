import fs from "fs";
import path from "path";

export interface GenreConfig {
  key: string;
  label: string;
  workloadGroup: string | null;
  hints: string[];
}

export interface QuestionnaireOption {
  label: string;
  jump: number | null;
  connect: number[];
  fix: boolean;
  exclusive: boolean;
  textInput: boolean;
}

export interface QuestionnaireQuestion {
  number: number;
  text: string;
  type: string;
  mustAnswer: boolean;
  page: number;
  pic: string | null;
  video: string | null;
  regex: string | null;
  semanticKey: string | null;
  genreKey: string | null;
  options: QuestionnaireOption[];
}

export interface Questionnaire {
  slug: string;
  version: number;
  title: string;
  introduction: string;
  supplement?: string | null;
  questions: QuestionnaireQuestion[];
}

export interface TesterMapping {
  weeklyPlay: Array<{ label: string; level: number }>;
  payment: Array<{ label: string; tier: string }>;
  device: Array<{ label: string; key: string }>;
  perspective: Array<{ label: string; key: string }>;
  playtimeBuckets: Array<{ label: string; level: number }>;
}

export interface WorkloadConfig {
  groups: Array<{ key: string; label: string; testDays: number; hoursPerDay: number; workloadHours: number; weight: number }>;
  benefitHoursPerUnit: number;
}

export interface BenefitsConfig {
  tiers: Array<{ condition: string; items: Array<{ game: string; reward: string; pic: string }> }>;
  teamRequests: Array<{ team: string; items: string[] }>;
}

export interface RedeemTierRule {
  cost: number;
  monthlyLimit: number | null;
  requirement: { minGamesPerMonth?: number; minHoursPerMonth?: number } | null;
}

export interface RedeemRules {
  tiers: RedeemTierRule[];
}

export interface TapTapTagMap {
  generic: string[];
  genres: Record<string, string[]>;
}

export interface ScoringConfig {
  volume: { hours: Array<[number, number]>; matches: Array<[number, number]>; vagueHours: number };
  rank: { levels: Array<{ score: number; label: string }>; games: Array<{ game: string; tiers: string[] }> };
}

export interface LibrarySeed {
  canonicalName: string;
  aliases: string[];
  genres: string[];
  subgenres: string[];
  source: string;
  confidence: number;
  notes: string;
}

const cache = new Map<string, unknown>();

function load<T>(name: string): T {
  const hit = cache.get(name);
  if (hit) return hit as T;
  const file = path.join(process.cwd(), "data", "tester", name);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as T;
  cache.set(name, parsed);
  return parsed;
}

export const testerConfig = {
  genres: () => load<{ genres: GenreConfig[] }>("genres.json").genres,
  questionnaire: () => load<Questionnaire>("questionnaire.json"),
  mapping: () => load<TesterMapping>("mapping.json"),
  workload: () => load<WorkloadConfig>("workload.json"),
  benefits: () => load<BenefitsConfig>("benefits.json"),
  redeemRules: () => load<RedeemRules>("redeem-rules.json"),
  taptapTags: () => load<TapTapTagMap>("taptap-tags.json"),
  scoring: () => load<ScoringConfig>("scoring.json"),
  library: () => load<LibrarySeed[]>("game-library.json"),
};

export function genreLabel(key: string): string {
  return testerConfig.genres().find((g) => g.key === key)?.label ?? key;
}

/** Nhãn đáp án Q8/Q24 → key dòng game (MOBA, FPS, BR...). */
export function genreKeyFromLabel(label: string): string | null {
  const t = label.trim();
  const rules: Array<[RegExp, string]> = [
    [/^MOBA/i, "MOBA"],
    [/FPS|Bắn Súng/i, "FPS"],
    [/Battle Royale/i, "BR"],
    [/^Auto Chess/i, "Autochess"],
    [/Card\s*RPG|CardRPG/i, "CardRPG"],
    [/^ActionRPG/i, "ARPG"],
    [/^MMORPG/i, "MMORPG"],
    [/^Thể Thao/i, "Sport"],
    [/^Extraction/i, "Extraction"],
    [/SLG|Chiến thuật/i, "SLG"],
    [/^Mô phỏng/i, "Simulator"],
    [/^Casual/i, "Casual"],
    [/^Sandbox/i, "Sandbox"],
    [/^Party/i, "Party"],
    [/^Khác/i, "Other"],
  ];
  return rules.find(([re]) => re.test(t))?.[1] ?? null;
}
