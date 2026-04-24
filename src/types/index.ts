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

export interface AIAnalysisResult {
  appId: number;
  gameName?: string;
  iconUrl?: string | null;
  source?: "database" | "external" | "csv-upload";
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
}
