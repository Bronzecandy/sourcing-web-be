export interface PaginationQuery {
  page?: string;
  limit?: string;
}

export interface RankingQuery extends PaginationQuery {
  date?: string;
  sort?: string;
  order?: "asc" | "desc";
  search?: string;
  tag?: string;
  platform?: "combined" | "android" | "ios";
}

export interface TapTapRawApp {
  id: number;
  title: string;
  icon?: { url: string; medium_url?: string; small_url?: string };
  banner?: { url: string };
  description?: { text: string };
  developer_note?: { text: string };
  tags?: Array<{ id: number; value: string }>;
  /** TapTap API may expose developer / publisher in various shapes */
  developer?: string | { name?: string };
  publisher?: string | { name?: string };
  developers?: Array<{ name?: string }>;
  /** Khối thông tin trên trang chi tiết TapTap (tên nhà phát hành / công ty...) */
  information?: Array<{ text?: string; value?: string; label?: string; title?: string }>;
  information_bar?: Array<{ text?: string; value?: string; label?: string }>;
  stat?: {
    rating?: {
      score: string;
      max: number;
      latest_score?: string;
      latest_review_count?: number;
      latest_version_review_count?: number;
    };
    vote_info?: Record<string, number>;
    hits_total?: number;
    fans_count?: number;
    reserve_count?: number;
    review_count?: number;
    feed_count?: number;
    topic_count?: number;
    play_total?: number;
    pc_download_count?: number;
    wish_count?: number;
  };
  rec_text?: string;
  screenshots?: Array<{ url: string; original_url?: string }>;
  update_time?: number;
  is_exclusive?: boolean;
  editor_choice?: boolean;
  supported_platforms?: Array<{ key: string }>;
  /** Bytes or MB depending on API — extractor normalizes to MB */
  apk_size?: number;
  package_size?: number;
  file_size?: number;
  download_size?: number;
}

export interface TapTapRawReview {
  id?: number;
  author?: {
    user?: { id: number; name: string; avatar?: { url: string } };
  };
  moment?: {
    extended_entities?: {
      topics?: Array<{ id: number; title: string }>;
    };
  };
  contents?: { text: string };
  score?: number;
  updated_time?: number;
  created_time?: number;
  ups_count?: number;
  comment_count?: number;
  sharing?: { description?: string };
  app?: TapTapRawApp;
}

export interface GameListItem {
  appId: number;
  title: string;
  iconUrl: string | null;
  androidRank: number | null;
  iosRank: number | null;
  rating: string | null;
  reviewCount: number | null;
  fansCount: number | null;
  reserveCount: number | null;
  tags: string[];
  isExclusive: boolean;
  editorChoice: boolean;
}

export interface DashboardStats {
  totalApps: number;
  totalDataPoints: number;
  totalReviews: number;
  latestDate: string | null;
  dateCount: number;
  topMovers: {
    gainers: Array<{ appId: number; title: string; change: number; iconUrl: string | null }>;
    losers: Array<{ appId: number; title: string; change: number; iconUrl: string | null }>;
  };
  tagDistribution: Array<{ tag: string; count: number }>;
}

export interface PotentialScoreResult {
  appId: number;
  title: string;
  iconUrl: string | null;
  momentumScore: number;
  engagementScore: number;
  stabilityScore: number;
  dataConfidence: number;
  compositeScore: number;
  currentRank: number | null;
  androidRank: number | null;
  iosRank: number | null;
  rating: string | null;
  fansCount: number | null;
  trend: "up" | "down" | "stable";
}

export interface BreakoutGame {
  appId: number;
  title: string;
  iconUrl: string | null;
  startRank: number;
  currentRank: number;
  improvement: number;
  daysTracked: number;
}

export interface AIFeedbackItem {
  point: string;
  mentionRate: number;
  tier: "frequent" | "moderate" | "rare";
}

export interface SentimentCriterion {
  score: number;
  reasoning: string;
}

export interface SentimentBreakdown {
  ratingDistribution: SentimentCriterion;
  textSentiment: SentimentCriterion;
  issueSeverity: SentimentCriterion;
  trendMomentum: SentimentCriterion;
  formula: string;
}

export type RubricScoreSource = "library" | "llm" | "merged";

/** Kết quả khớp thư viện deterministic trước khi merge LLM */
export interface LibraryResolvedEntry {
  criterionId: string;
  score: number;
  matchedKey: string;
  confidence: "high" | "medium" | "low";
}

/** Yêu cầu bổ sung/thư viện khi không khớp — hiển thị cho admin (tiếng Anh) */
export interface LibraryRequestItem {
  kind:
    | "genre_tags"
    | "studio"
    | "game_size"
    | "ip_theme"
    | "system_spec"
    | "art_style"
    | "update_signal"
    | "community_signal";
  label: string;
  /** English description for the admin / merge queue (legacy name `messageVi` was Vietnamese). */
  detailEn: string;
  jsonSuggestion: Record<string, unknown>;
}

/** Mức rủi ro / nghiêm trọng (Red Flag) — không gộp vào điểm rubric chính */
export type RedFlagSeverity = "none" | "low" | "medium" | "high";

export interface RubricCriterionOutput {
  id: string;
  partId: string;
  elementVi: string;
  input: string;
  weightInPart: number;
  score: number | null;
  /** Chỉ dùng khi partId === "red_flag": mức rủi ro, không phải điểm 0–100 */
  severity?: RedFlagSeverity | null;
  /**
   * Red Flag: hiển thị Có (true) / Không (false) / chưa rõ (null) thay cho ô điểm.
   * Với bạo lực/sexual: Có = có rủi ro (severity khác "none"); Không = "none"; null = chưa đủ dữ liệu.
   */
  flagPresent?: boolean | null;
  reasoning?: string;
  mentionCount?: number;
  /** Điểm mạnh gắn với tiêu chí này (từ LLM, tiếng Việt) */
  strengths?: string[];
  /** Điểm yếu gắn với tiêu chí này */
  weaknesses?: string[];
  source: RubricScoreSource;
  confidence?: "high" | "medium" | "low";
  matchedLibraryKey?: string;
}

export interface RubricRedFlagBlock {
  /** true = có dấu hiệu; false = không; null/undefined = chưa đủ dữ liệu (API tri-state) */
  politics?: boolean | null;
  casino?: boolean | null;
  /** Tôn giáo nhạy cảm, cực đoan, nội dung phản cảm tôn giáo tại VN */
  religionSensitive?: boolean | null;
  /** Mức bạo lực gây sốc / rủi ro thị trường (không phải “điểm” rubric) */
  violenceSeverity?: RedFlagSeverity | null;
  sexualSeverity?: RedFlagSeverity | null;
  /**
   * @deprecated Phản hồi LLM cũ có thể còn số; ưu tiên hiển thị `violenceSeverity`. Khi merge, có thể suy ra severity từ số nếu thiếu chuỗi.
   */
  violenceScore?: number | null;
  /**
   * @deprecated Tương tự `violenceScore`.
   */
  sexualScore?: number | null;
  otherTaboosNote?: string | null;
}

/** Tổng hợp theo từng đầu mục lớn (manifest.parts) — phục vụ hiển thị & đối chiếu công thức điểm tổng. */
export interface RubricPartRollup {
  partId: string;
  labelVi: string;
  /** Trọng số phần đang dùng để tính điểm tổng (sau điều chỉnh gói thể loại nếu có). */
  weightInTotal: number;
  /** Trọng số trong manifest.json (trước điều chỉnh); khác weightInTotal khi có gói MOBA/Card RPG/… */
  manifestWeightInTotal?: number;
  /** Trung bình có trọng số của các tiêu chí con có điểm (1–100); null nếu không có tiêu chí nào có điểm. */
  partAverageScore: number | null;
  /** Σ weightInPart chỉ các tiêu chí có điểm — mẫu số khi tính TB phần. */
  scoredWeightSumInPart: number;
  /** Phần này có đưa vào điểm tổng không (cần ít nhất một tiêu chí có điểm). */
  includedInGlobalScore: boolean;
  /** Phần đóng góp vào tử số: weightInTotal × partAverageScore khi included; ngược lại null. */
  numeratorContribution: number | null;
}

/** Quyết định thử nghiệm từ điểm có trọng số 0–100 và red flag cứng. */
export type RubricTestDecision =
  | "must_test"
  | "suitable_test"
  | "consider_test"
  | "no_test"
  | "blocked_red_flag";

export interface RubricAggregate {
  weightedScore: number | null;
  band5: number | null;
  decision: RubricTestDecision;
  lowScoreCriteriaCount: number;
  redFlagHardGate: boolean;
  /** Chi tiết từng phần (bản mới); thiếu ở kết quả lưu cũ. */
  partRollups?: RubricPartRollup[];
  /** Mẫu số công thức tổng (bản mới). */
  globalWeightDenominator?: number;
}

export interface RubricBlock {
  manifestVersion: number;
  /** Gói thể loại dùng để cân trọng số các phần (base | cardRpg | moba | …). */
  genrePackResolved?: string | null;
  criteria: RubricCriterionOutput[];
  aggregate: RubricAggregate;
  redFlag: RubricRedFlagBlock;
  dataConfidence: {
    reviewCount: number;
    meetsThreshold: boolean;
    threshold: number;
  };
}

/** Bảng Có/Không nhanh cho FE (đặt ngay sau redFlagAtAGlance) */
export interface RedFlagsChecklist {
  politics: boolean | null;
  religion: boolean | null;
  casino: boolean | null;
  /** Có rủi ro bạo lực gore (severity ≠ none) */
  violenceConcern: boolean | null;
  /** Có rủi ro sexual (severity ≠ none) */
  sexualConcern: boolean | null;
}

/** Tóm tắt red flag đặt đầu response để UI đọc nhanh (không thay thế rubric.redFlag đầy đủ). */
export interface RedFlagAtAGlance {
  headlineVi: string;
  riskLevel: "clear" | "low" | "medium" | "high" | "critical";
  blockedByHardGate: boolean;
  /** Politics/casino hoặc bạo lực/gợi dục từ medium trở lên */
  hasElevatedRisk: boolean;
  politics: boolean | null;
  religion: boolean | null;
  casino: boolean | null;
  violenceSeverity: RedFlagSeverity | null;
  sexualSeverity: RedFlagSeverity | null;
  otherTaboosNote?: string | null;
}

export interface AIAnalysisResult {
  appId: number;
  gameName?: string;
  iconUrl?: string | null;
  /** Đặt gần đầu JSON để client hiển thị red flag trước phần rubric chi tiết */
  redFlagAtAGlance?: RedFlagAtAGlance;
  /** Có/Không từng mục — ưu tiên bind ô “điểm” trên UI */
  redFlagsChecklist?: RedFlagsChecklist;
  source?: "database" | "external" | "csv-upload" | "steam";
  /** Joined bullets for backward compatibility */
  summary: string;
  /** One bullet per string (Vietnamese from LLM) */
  summaryBullets?: string[];
  strengths: AIFeedbackItem[];
  weaknesses: AIFeedbackItem[];
  sentimentScore: number;
  sentimentBreakdown?: SentimentBreakdown;
  topics: Record<string, number>;
  recentTrend: string;
  recentTrendBullets?: string[];
  reviewsAnalyzed: number;
  bucketCounts: Record<string, number>;
  dateRangeStart: string | null;
  dateRangeEnd: string | null;
  analyzedAt: string;
  reviewWindowMode?: "all" | "days" | "range";
  reviewWindowDays?: 7 | 14 | 30 | 60;
  reviewFilterFrom?: string;
  reviewFilterTo?: string;
  developerName?: string | null;
  publisherName?: string | null;
  /** Extended rubric + library merge (optional for older stored analyses) */
  rubric?: RubricBlock;
  /** Gợi ý bổ sung thư viện JSON khi thiếu khớp Genre/Developer/... */
  libraryRequests?: LibraryRequestItem[];
}
