export const RADAR_BOARDS = [
  { id: "reserve_growth", labelVi: "Reserve tăng trưởng", sheet: "Top 20 Reserve - Growth" },
  { id: "reserve_scale", labelVi: "Reserve quy mô", sheet: "Top 20 Reserve - Scale" },
  { id: "new_launch", labelVi: "New Launch", sheet: "Top 20 New Launch" },
] as const;

export type RadarBoardId = (typeof RADAR_BOARDS)[number]["id"];

export const NEXT_ACTIONS = [
  "Test Viable - High Potential",
  "Test Viable - Medium Potential",
  "Test Viable - Low Potential",
  "Monitor - High Potential",
  "Monitor - Mid Potential",
  "Monitor - Low Potential",
  "Temporary Ignore",
  "Drop",
] as const;

export type NextAction = (typeof NEXT_ACTIONS)[number];

export interface RadarGameFacts {
  appId: number;
  title: string;
  tags: string[];
  developer: string | null;
  publisher: string | null;
  rating: string | null;
  reserveCount: number | null;
  downloadCount: number | null;
  fansCount: number | null;
  installSizeMb: number | null;
  notes: string[];
}

export interface RadarDecision {
  titleEn: string;
  insights: string;
  nextAction: NextAction;
  reason: string;
  releaseLabel: string;
  playableNow: boolean;
  genre: string;
  publisher: string;
  toolAdjustments: string;
}

export interface RadarRowPayload extends RadarDecision {
  board: RadarBoardId;
  rank: number;
  appId: number;
  title: string;
  score: number;
  taptapUrl: string;
  overviewUrl: string;
  screeningUrl: string | null;
  analysisScore: number | null;
  firstInRecap: boolean;
  previousAction: string | null;
  previousDate: string | null;
}

export interface RadarCountRow {
  label: string;
  counts: Record<string, number>;
}

export interface RadarSummary {
  periodCode: string;
  dateLabel: string;
  copyText: string;
  executiveParagraphs: string[];
  testableNow: string[];
  upcoming: string[];
  monitorNoDateCount: number;
  counts: RadarCountRow[];
}

export function boardLabel(board: string): string {
  return RADAR_BOARDS.find((b) => b.id === board)?.labelVi ?? board;
}

export function isNextAction(value: string): value is NextAction {
  return (NEXT_ACTIONS as readonly string[]).includes(value);
}

export function actionFamily(action: string): "viable" | "high" | "mid" | "low" | "ignore" | "drop" | "other" {
  if (action.startsWith("Test Viable")) return "viable";
  if (action.includes("High")) return "high";
  if (action.includes("Mid") || action.includes("Medium")) return "mid";
  if (action.includes("Low")) return "low";
  if (action.startsWith("Temporary")) return "ignore";
  if (action === "Drop") return "drop";
  return "other";
}

export function needsScreening(action: string): boolean {
  return action.startsWith("Test Viable") || action.startsWith("Monitor");
}
