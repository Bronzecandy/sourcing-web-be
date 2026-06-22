export interface PaginationQuery {
  page?: string;
  limit?: string;
}

export type RankingSegment = "reserve" | "launched";

export interface RankingQuery extends PaginationQuery {
  date?: string;
  sort?: string;
  order?: "asc" | "desc";
  search?: string;
  tag?: string;
  platform?: "combined" | "android" | "ios";
  segment?: RankingSegment;
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
  /** Set when segment=launched */
  primaryLaunchBoard?: "pop" | "hot" | "new" | null;
  launchCategory?: "new_launch" | "established_launch" | null;
  hotAndroidRank?: number | null;
  hotIosRank?: number | null;
  popAndroidRank?: number | null;
  popIosRank?: number | null;
  newAndroidRank?: number | null;
  newIosRank?: number | null;
  downloadCount?: number | null;
  releaseDate?: string | null;
  launchBoardTags?: Array<{ board: "pop" | "hot" | "new"; rank: number | null }>;
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

export type DistributionMetric = "reserve" | "download" | "rating" | "reviewCount" | "fans";
export type DistributionLifecycle = "reserve" | "new" | "old" | "unknown";
export type DistributionLifecycleFilter = "all" | DistributionLifecycle;

export interface BucketDefinition {
  label: string;
  min: number;
  max: number | null;
}

export interface DistributionBucket {
  label: string;
  min: number;
  max: number | null;
  count: number;
  countDelta: number;
  metricSum: number;
  metricDelta: number;
  byLifecycle: Record<DistributionLifecycle, number>;
}

export interface DistributionSummary {
  totalGames: number;
  byLifecycle: Record<DistributionLifecycle, number>;
  periodStart: string | null;
  periodEnd: string | null;
}

export interface DistributionMonthlyPoint {
  month: number;
  periodStart: string | null;
  periodEnd: string | null;
  totalGames: number;
  totalMetricSum: number;
  totalMetricDelta: number;
}

export interface DistributionQuery {
  year: number;
  month?: number;
  metric: DistributionMetric;
  lifecycle: DistributionLifecycleFilter;
}

export interface DistributionMonthResponse {
  mode: "month";
  metric: DistributionMetric;
  lifecycle: DistributionLifecycleFilter;
  year: number;
  month: number;
  buckets: DistributionBucket[];
  summary: DistributionSummary;
  message?: string;
}

export interface DistributionYearResponse {
  mode: "year";
  metric: DistributionMetric;
  lifecycle: DistributionLifecycleFilter;
  year: number;
  monthlyTrend: DistributionMonthlyPoint[];
  buckets: DistributionBucket[];
  summary: DistributionSummary;
}

export type DistributionResponse = DistributionMonthResponse | DistributionYearResponse;

export interface DistributionMeta {
  years: number[];
  months: Record<number, number[]>;
  metrics: Array<{ id: DistributionMetric; label: string }>;
  bucketDefinitions: Record<DistributionMetric, BucketDefinition[]>;
  growthBucketDefinitions: {
    count: BucketDefinition[];
    rating: BucketDefinition[];
  };
}

/** Tab lifecycle — không gồm "all" / "unknown". */
export type DistributionTab = "reserve" | "new" | "old";

export interface DistributionTrendPoint {
  key: string;
  label: string;
  periodStart: string | null;
  periodEnd: string | null;
  totalGames: number;
  metricSum: number;
  metricDelta: number;
}

export interface DistributionGrowthBucket {
  label: string;
  min: number;
  max: number | null;
  count: number;
  totalDelta: number;
  sharePct: number;
}

export interface DistributionRatingInsights {
  highRatingShare: number;
  lowRatingShare: number;
  improvingShare: number;
  decliningShare: number;
  avgRating: number;
  avgRatingDelta: number;
  vote5StarShare: number | null;
}

export interface DistributionTabInsights {
  primaryMetric: DistributionMetric;
  label: string;
  value: string;
  sub?: string;
  items: Array<{ label: string; value: string }>;
}

export interface DistributionMetricBlock {
  metric: DistributionMetric;
  label: string;
  /** @deprecated use absoluteBuckets */
  buckets: DistributionBucket[];
  absoluteBuckets: DistributionBucket[];
  growthBuckets: DistributionGrowthBucket[];
  totalGames: number;
  metricSum: number;
  metricDelta: number;
  gamesWithGrowth: number;
  gamesIncreased: number;
  gamesDecreased: number;
  gamesFlat: number;
  trend: DistributionTrendPoint[];
  ratingInsights?: DistributionRatingInsights;
}

export interface DistributionOverviewQuery {
  year?: number | null;
  month?: number;
  lifecycle: DistributionTab;
}

export interface DistributionOverviewResponse {
  lifecycle: DistributionTab;
  year: number | null;
  month: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  segmentCounts: Record<DistributionLifecycle, number>;
  segmentTotal: number;
  metrics: DistributionMetricBlock[];
  tabInsights: DistributionTabInsights;
  message?: string;
}

export interface DistributionTrendsResponse {
  lifecycle: DistributionTab;
  year: number | null;
  month: number | null;
  metrics: Array<{ metric: DistributionMetric; trend: DistributionTrendPoint[] }>;
}

export type PotentialSegment = "reserve" | "launched";
export type LaunchCategory = "new_launch" | "established_launch";

export interface PotentialScoreResult {
  appId: number;
  title: string;
  iconUrl: string | null;
  /** Merged scale + growth (reserve/download audience). */
  audienceScore: number;
  /** @deprecated alias of audienceScore */
  scaleScore?: number;
  /** @deprecated alias of audienceScore */
  growthScore?: number;
  ratingScore: number;
  rankQualityScore: number;
  launchBoardScore?: number;
  dataConfidence: number;
  compositeScore: number;
  currentRank: number | null;
  /** Reserve board ranks (legacy UI field names). */
  androidRank: number | null;
  iosRank: number | null;
  hotAndroidRank?: number | null;
  hotIosRank?: number | null;
  popAndroidRank?: number | null;
  popIosRank?: number | null;
  newAndroidRank?: number | null;
  newIosRank?: number | null;
  rating: string | null;
  fansCount: number | null;
  trend: "up" | "down" | "stable";
  segment?: PotentialSegment;
  launchCategory?: LaunchCategory;
  releaseDate?: string | null;
  primaryLaunchBoard?: "pop" | "hot" | "new" | null;
  launchBoardTags?: Array<{ board: "pop" | "hot" | "new"; rank: number | null }>;
  downloadCount?: number | null;
}

export interface PotentialLifecycleMeta {
  firstLaunchDate: string | null;
  firstLaunchIndex: number;
  hasReservePhase: boolean;
  hasLaunchPhase: boolean;
  preLaunchDayCount: number;
  postLaunchDayCount: number;
  transitioned: boolean;
  reserveWindowEnd?: string | null;
  reserveWindowDays?: number;
}

/** Metric the scale/growth pillars measure for this segment. */
export type PotentialScaleMetric = "reserve" | "download";

/** Merged audience pillar — scale base tier + growth bonus (forgiving when base is large). */
export interface PotentialAudienceBlock {
  score: number;
  metric: PotentialScaleMetric;
  start: number | null;
  end: number | null;
  delta: number;
  /** Base points from absolute scale tier (Distribution buckets). */
  baseValue: number;
  baseTierLabel: string | null;
  /** Additive bonus/penalty from growth tier. */
  growthBonus: number;
  growthTierLabel: string | null;
  /** How much growth bonus was applied (lower when base is high). */
  growthWeight: number;
}

/** @deprecated use PotentialAudienceBlock */
export type PotentialScaleBlock = PotentialAudienceBlock;
/** @deprecated use PotentialAudienceBlock */
export type PotentialGrowthBlock = PotentialAudienceBlock;

/** Rating pillar — start-rating base + per-0.1 delta adjustment. */
export interface PotentialRatingBlock {
  score: number;
  start: number | null;
  end: number | null;
  delta: number;
  /** Base from rating at period start (8★→60, 10★→90). */
  baseValue: number;
  /** Points added/subtracted for rating change (±5 per 0.1). */
  deltaAdjustment: number;
}

/** Consolidated rank quality + stability (replaces old momentum + stability). */
export interface PotentialRankQualityBlock {
  score: number;
  /** Mean per-day tier score (top-10→100, top-20→80, top-50→55, …). */
  positionQuality: number;
  top10Rate: number;
  top20Rate: number;
  top50Rate: number;
  /** % days in top 20 (presence). */
  presenceScore: number;
  /** Longest consecutive top-20 streak, scaled 0–100. */
  streakScore: number;
  volatilityScore: number;
  /** Climb / maintenance movement. */
  movementScore: number;
  avgRank: number;
  bestRank: number;
  rankStart: number;
  rankEnd: number;
  change: number;
  stdDev: number;
  longestTop20Streak: number;
  daysTracked: number;
}

export interface GamePotentialDetail {
  audience: PotentialAudienceBlock;
  /** @deprecated use audience */
  scale?: PotentialAudienceBlock;
  /** @deprecated use audience */
  growth?: PotentialAudienceBlock;
  rating: PotentialRatingBlock;
  rankQuality: PotentialRankQualityBlock;
  confidence: {
    coverage: number;
    multiplier: number;
    dataPoints: number;
    analysisDays: number;
  };
  compositeScore: number;
  rawComposite: number;
  /** True when rank chart was prevented from dragging composite below audience+rating core. */
  floorApplied?: boolean;
  segment?: PotentialSegment;
  preLaunchBonus?: number;
  /** Launched: pre-launch reserve normalized 0–100 (5% weight) */
  preLaunchScore?: number;
  /** Launched: launch-chart breadth score (15% weight in composite) */
  launchBoard?: {
    primaryBoard: "pop" | "hot" | "new" | null;
    primaryRank: number | null;
    score: number;
    /** BXH chính + hạng hôm nay (60% of launch-board score) */
    chartQuality: number;
    /** % ngày trên Pop/Hot/New, ưu tiên Pop (25%) */
    consistency: number;
    /** Có mặt trên bao nhiêu loại BXH hôm nay (15%) */
    coverage: number;
    popDayRate: number;
    hotDayRate: number;
    newDayRate: number;
    activeBoardCount: number;
    activeBoards: Array<{ board: "pop" | "hot" | "new"; rank: number | null }>;
  };
}

export interface PotentialBreakdown {
  lifecycle: PotentialLifecycleMeta;
  reserve: GamePotentialDetail | null;
  launched: GamePotentialDetail | null;
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
  /** Gói thể loại (chỉ tiêu chí genre_specific). */
  genrePack?: string | null;
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
  /** Cách người chơi đề cập từng red flag trong review (từ LLM). */
  playerMentions?: {
    summary?: string | null;
    politics?: string | null;
    religion?: string | null;
    casino?: string | null;
    violence?: string | null;
    sexual?: string | null;
  };
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
  /** Nhiều gói thể loại có trọng số (multi-genre blend). */
  genrePacksResolved?: GenrePackResolvedItem[];
  /** Giải thích AI về phân bổ gói thể loại. */
  genrePackBlendReasoning?: string;
  /** Điểm trung bình từng gói thể loại (khi có gói non-base). */
  genrePackRollups?: GenrePackRollup[];
  criteria: RubricCriterionOutput[];
  aggregate: RubricAggregate;
  redFlag: RubricRedFlagBlock;
  dataConfidence: {
    reviewCount: number;
    meetsThreshold: boolean;
    threshold: number;
  };
}

export interface GenrePackResolvedItem {
  packId: string;
  weight: number;
  labelVi?: string;
}

/** Điểm trung bình có trọng số trong phần Theo thể loại, theo từng gói genre. */
export interface GenrePackRollup {
  packId: string;
  weight: number;
  labelVi?: string;
  averageScore: number | null;
}

export interface GenrePackPlan {
  packs: GenrePackResolvedItem[];
  reasoning: string;
  ratioPreset?: "7:3" | "6:4" | null;
}

export interface AnalysisPrepareExistingItem {
  appId: number;
  gameName?: string;
  analyzedAt?: string;
  reviewsAnalyzed?: number;
  score?: number | null;
  genrePacks?: GenrePackResolvedItem[];
  genrePackResolved?: string | null;
}

export interface AnalysisPrepareResult {
  appId: number;
  gameName: string;
  iconUrl: string | null;
  tagInferredPacks: string[];
  availablePackIds: string[];
  genrePackPlan: GenrePackPlan;
  existingAnalyses: AnalysisPrepareExistingItem[];
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
  /** Chi tiết bổ sung — cách người chơi nhắc từng vấn đề. */
  detailVi?: string[];
  playerMentions?: RubricRedFlagBlock["playerMentions"];
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
  /** Tổng review trong khoảng (trước khi giới hạn cap AI, mặc định 15k). */
  reviewsTotalInWindow?: number;
  reviewsCapped?: boolean;
  bucketCounts: Record<string, number>;
  dateRangeStart: string | null;
  dateRangeEnd: string | null;
  analyzedAt: string;
  /** UserAiAnalysis row id — dùng cho URL chia sẻ. */
  analysisId?: string;
  /** User who ran this analysis (from UserAiAnalysis row; not in stored payload). */
  analyzedByUserId?: string;
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
