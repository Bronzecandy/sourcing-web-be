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

export type PotentialTier = "High" | "Mid" | "Low";

/**
 * launched / open_beta: chơi được ngay.
 * launch_date: chốt ngày ra mắt hoặc 公测 trong tương lai.
 * closed_beta: test kín có ngày; test_recruit: đang tuyển test; test_running: test kín đang chạy.
 * event: mốc nội dung (season, update) — không tính là lịch ra mắt/test.
 */
export type ScheduleKind =
  | "launched"
  | "open_beta"
  | "launch_date"
  | "closed_beta"
  | "test_recruit"
  | "test_running"
  | "event";

export interface RadarSchedule {
  kind: ScheduleKind | null;
  /** YYYY-MM-DD */
  date: string | null;
  label: string;
  source: "info" | "hints" | "posts" | "llm" | null;
  raw: string | null;
}

export interface RadarOfficialPost {
  title: string;
  summary: string;
  date: string | null;
}

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
  /** TapTap app/v4/detail `flag`: 1 = đặt trước, 2/3 = đã tải/chơi được. */
  flag?: number | null;
  hints?: string[];
  developerNote?: string | null;
  officialPosts?: RadarOfficialPost[];
  /** "Android 正式上线日期" hoặc release_date trong raw. */
  releaseDate?: string | null;
  updateDate?: string | null;
  /** "联网 App" trên trang TapTap: true/false, null khi không có. */
  online?: boolean | null;
  videoUrl?: string | null;
  /** false khi không đọc được trang TapTap kỳ này. */
  fetched?: boolean;
}

/** Dữ kiện LLM trích từ trang TapTap — code dùng để áp rule Next Action. */
export interface RadarFlags {
  liveService: boolean;
  offlineSingle: boolean;
  ugc: boolean;
  sensitiveTheme: string;
  nicheReason: string;
  aaaGraphics: boolean;
  publishedInVn: boolean;
  vnIp: boolean;
  internationalRelease: boolean;
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
  tier?: PotentialTier | null;
  schedule?: RadarSchedule;
  flags?: RadarFlags;
  alerts?: string[];
  videoUrl?: string | null;
  /** Giữ Next Action kỳ trước vì không đọc được TapTap/LLM kỳ này. */
  carriedOver?: boolean;
}

export interface RadarMetrics {
  reserveCount: number | null;
  downloadCount: number | null;
  /** Quy mô dùng cho ngưỡng (đặt trước hoặc tải, lấy số lớn hơn). */
  scale: number | null;
  scaleKind: "reserve" | "download" | null;
  rating: string | null;
  fansCount: number | null;
  audienceScore: number | null;
  ratingScore: number | null;
  rankQualityScore: number | null;
  dataConfidence: number | null;
  compositeScore: number | null;
  momentumScore: number | null;
  trend: string | null;
  releaseDate: string | null;
}

/** Tình trạng test nội bộ lấy từ Tester Program (TestCampaign gắn appId). */
export interface RadarInternalTest {
  campaignId: string;
  status: string;
  label: string;
  startDate: string | null;
  endDate: string | null;
  team: string | null;
  result: string | null;
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
  /** Không có ở cùng bảng kỳ trước. */
  firstInRecap: boolean;
  /** Không có ở bất kỳ bảng nào kỳ trước. */
  newThisPeriod?: boolean;
  previousAction: string | null;
  previousDate: string | null;
  metrics?: RadarMetrics;
  scheduleChanged?: boolean;
  scheduleChangeNote?: string;
  internalTest?: RadarInternalTest | null;
}

export interface RadarCountRow {
  label: string;
  counts: Record<string, number>;
}

/** Một dòng gạch đầu dòng Phần 3: tên game (link Overview) + câu mô tả. */
export interface RadarBullet {
  appId: number;
  nameCn: string;
  nameEn: string;
  overviewUrl: string;
  text: string;
  isNew: boolean;
  repeat: boolean;
}

export interface RadarSection3 {
  newEntries: RadarBullet[];
  scheduleUpdates: RadarBullet[];
  testable: RadarBullet[];
  market: Array<{ publisher: string; items: RadarBullet[] }>;
}

export interface RadarCarryOver {
  appId: number;
  title: string;
  titleEn: string;
  nextAction: string;
  previousDate: string;
  overviewUrl: string;
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
  previousDate?: string | null;
  previousPeriodCode?: string | null;
  testingThisWeek?: string[];
  section3?: RadarSection3;
  carryOver?: RadarCarryOver[];
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

/** Thứ tự ưu tiên: số nhỏ hơn = cao hơn. */
export function actionRank(action: string): number {
  const idx = (NEXT_ACTIONS as readonly string[]).indexOf(action);
  return idx === -1 ? NEXT_ACTIONS.length : idx;
}
