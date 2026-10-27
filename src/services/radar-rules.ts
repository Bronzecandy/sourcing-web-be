import fs from "fs";
import path from "path";
import {
  actionRank,
  type NextAction,
  type PotentialTier,
  type RadarFlags,
  type RadarGameFacts,
  type RadarMetrics,
} from "./radar-types";

export const THRESHOLDS = {
  high: { score: 85, scale: 1_000_000 },
  mid: { score: 75, scale: 500_000 },
  low: { score: 65, scale: 100_000 },
} as const;

/** Dòng game lớn: chỉ số chưa đủ thì Temporary Ignore (không Drop). */
const BIG_GENRE_RE =
  /MOBA|Card\s*RPG|Idle\s*RPG|Extraction|Battle\s*Royale|\bBR\b|SLG|MMORPG|MMO|RTS|卡牌|放置|搜打撤|大逃杀|策略|吃鸡/i;

interface PublisherEntry {
  name: string;
  topTier: boolean;
  aliases: string[];
}

let publishersCache: PublisherEntry[] | null = null;

function publisherBook(): PublisherEntry[] {
  if (publishersCache) return publishersCache;
  try {
    const file = path.join(process.cwd(), "data", "radar", "top-tier-publishers.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { publishers?: PublisherEntry[] };
    publishersCache = Array.isArray(parsed.publishers) ? parsed.publishers : [];
  } catch {
    publishersCache = [];
  }
  return publishersCache;
}

/** NPH lớn khớp theo tên/alias (tên LLM, publisher, developer trên trang TapTap). */
export function matchPublisher(...names: Array<string | null | undefined>): PublisherEntry | null {
  const haystack = names
    .filter((n): n is string => typeof n === "string" && n.trim().length > 0)
    .map((n) => n.toLowerCase());
  if (haystack.length === 0) return null;
  for (const entry of publisherBook()) {
    const keys = [entry.name.toLowerCase(), ...entry.aliases.map((a) => a.toLowerCase())];
    if (haystack.some((h) => keys.some((k) => h.includes(k)))) return entry;
  }
  return null;
}

export function isBigGenre(...texts: Array<string | null | undefined>): boolean {
  return texts.some((t) => typeof t === "string" && BIG_GENRE_RE.test(t));
}

export function formatScale(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `~${m >= 10 ? m.toFixed(1) : m.toFixed(2)} triệu`;
  }
  if (n >= 1_000) return `~${Math.round(n / 1_000)}K`;
  return String(Math.round(n));
}

export function scaleLabel(metrics: Pick<RadarMetrics, "scale" | "scaleKind">): string {
  if (metrics.scale == null) return "chưa có số đặt trước/tải";
  return metrics.scaleKind === "download"
    ? `${formatScale(metrics.scale)} lượt tải`
    : `đặt trước ${formatScale(metrics.scale)}`;
}

export function potentialTier(score: number, scale: number | null, topTierPublisher: boolean): PotentialTier | null {
  if (scale == null || !Number.isFinite(score)) return null;
  if (score > THRESHOLDS.high.score && scale > THRESHOLDS.high.scale && topTierPublisher) return "High";
  if (score > THRESHOLDS.mid.score && scale > THRESHOLDS.mid.scale) return "Mid";
  if (score > THRESHOLDS.low.score && scale > THRESHOLDS.low.scale) return "Low";
  return null;
}

export function dropReason(flags: RadarFlags, facts: RadarGameFacts, internalUnsuitable: boolean): string | null {
  if (internalUnsuitable) return "Đã test nội bộ, kết quả không phù hợp";
  if (flags.offlineSingle || facts.online === false) {
    return flags.ugc ? "UGC offline/single-player" : "offline/single-player";
  }
  if (flags.sensitiveTheme.trim()) return `chủ đề nhạy cảm/niche tại VN (${flags.sensitiveTheme.trim()})`;
  if (flags.nicheReason.trim()) return `gameplay niche tại VN (${flags.nicheReason.trim()})`;
  return null;
}

export function barrierReason(flags: RadarFlags): string | null {
  if (flags.aaaGraphics) return "đồ họa/cấu hình AAA";
  if (flags.publishedInVn) return "đã có NPH tại VN";
  if (flags.vnIp) return "IP đã phát hành tại VN";
  if (flags.internationalRelease) return "đã phát hành quốc tế/Steam";
  return null;
}

function daysAgo(iso: string, todayIso: string): number {
  return Math.round(
    (new Date(`${todayIso}T00:00:00.000Z`).getTime() - new Date(`${iso}T00:00:00.000Z`).getTime()) / 86_400_000,
  );
}

export function scoreAlerts(score: number, metrics: RadarMetrics, facts: RadarGameFacts, todayIso: string): string[] {
  const alerts: string[] = [];
  const scale = metrics.scale;
  if (score >= 85 && scale != null && scale < THRESHOLDS.low.scale) {
    alerts.push(`ALERT: điểm cao (${score.toFixed(1)}) nhưng quy mô thấp (${scaleLabel(metrics)})`);
  }
  if (scale != null && scale >= THRESHOLDS.mid.scale && score < THRESHOLDS.mid.score) {
    alerts.push(`ALERT: quy mô tốt (${scaleLabel(metrics)}) nhưng điểm chưa phản ánh (${score.toFixed(1)})`);
  }
  const updated = facts.updateDate?.slice(0, 10);
  if (updated && /^\d{4}-\d{2}-\d{2}$/.test(updated) && daysAgo(updated, todayIso) > 730) {
    alerts.push(`ALERT: trang TapTap không cập nhật từ ${updated}, số đặt trước có thể là tồn dư`);
  }
  return alerts;
}

const VIABLE_BY_TIER: Record<PotentialTier, NextAction> = {
  High: "Test Viable - High Potential",
  Mid: "Test Viable - Medium Potential",
  Low: "Test Viable - Low Potential",
};

const MONITOR_BY_TIER: Record<PotentialTier, NextAction> = {
  High: "Monitor - High Potential",
  Mid: "Monitor - Mid Potential",
  Low: "Monitor - Low Potential",
};

export interface RuleInput {
  score: number;
  metrics: RadarMetrics;
  flags: RadarFlags;
  facts: RadarGameFacts;
  playable: "launched" | "open_beta" | null;
  topTierPublisher: boolean;
  internalUnsuitable: boolean;
  genre: string;
  todayIso: string;
}

export interface RuleOutput {
  nextAction: NextAction;
  tier: PotentialTier | null;
  reason: string;
  alerts: string[];
}

/**
 * Thứ tự theo skill game-radar-recap + QA:
 * Drop → tier theo điểm/quy mô → barrier ép Low → chơi được (ra mắt/open beta) = Test Viable
 * → chưa chơi được + có tier = Monitor (kể cả chưa có ngày) → còn lại Temporary Ignore.
 */
export function applyRadarRules(input: RuleInput): RuleOutput {
  const { score, metrics, flags, facts, playable, genre } = input;
  const tier = potentialTier(score, metrics.scale, input.topTierPublisher);
  const drop = dropReason(flags, facts, input.internalUnsuitable);
  if (drop) return { nextAction: "Drop", tier, reason: drop, alerts: [] };

  const alerts = scoreAlerts(score, metrics, facts, input.todayIso);
  const barrier = barrierReason(flags);
  const effective: PotentialTier | null = barrier ? "Low" : tier;
  const genreText = genre.trim() || "dòng game phù hợp";

  if (playable) {
    if (!effective) {
      alerts.push(
        `ALERT: chơi được nhưng chỉ số dưới ngưỡng Low (điểm ${score.toFixed(1)}, ${scaleLabel(metrics)})`,
      );
      return { nextAction: "Test Viable - Low Potential", tier: null, reason: `${genreText}, ${scaleLabel(metrics)}`, alerts };
    }
    const reason = barrier
      ? `${barrier}, ${scaleLabel(metrics)}`
      : `${playable === "open_beta" ? "đang open beta" : "đã ra mắt"}, ${genreText}, ${scaleLabel(metrics)}`;
    return { nextAction: VIABLE_BY_TIER[effective], tier: effective, reason, alerts };
  }

  if (effective && flags.liveService) {
    const reason = barrier
      ? `${barrier}, theo dõi để nắm thông tin thị trường`
      : `${genreText}, ${scaleLabel(metrics)}`;
    return { nextAction: MONITOR_BY_TIER[effective], tier: effective, reason, alerts };
  }

  let reason: string;
  if (!flags.liveService) reason = "chưa phải game live-service";
  else if (isBigGenre(genre, facts.tags.join(" "))) reason = `dòng game lớn nhưng chỉ số chưa cao (${scaleLabel(metrics)})`;
  else reason = `chỉ số chưa đủ (điểm ${score.toFixed(1)}, ${scaleLabel(metrics)})`;
  return { nextAction: "Temporary Ignore", tier: null, reason, alerts };
}

function viDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${Number(d)}/${Number(m)}/${y}`;
}

/** Tool Adjustments: Game mới → Nâng/Hạ so với kỳ trước → ALERT. */
export function adjustmentText(input: {
  isNewOnBoard: boolean;
  prevAction: string | null;
  prevDate: string | null;
  nextAction: string;
  reason: string;
  alerts: string[];
}): string {
  const parts: string[] = [];
  if (input.isNewOnBoard) parts.push("Game mới (chưa có ở recap kỳ trước)");
  if (input.prevAction && input.prevAction !== input.nextAction) {
    const up = actionRank(input.nextAction) < actionRank(input.prevAction);
    const when = input.prevDate ? ` (${viDate(input.prevDate)})` : "";
    parts.push(
      `${up ? "Nâng" : "Hạ"} từ ${input.prevAction} ${up ? "lên" : "xuống"} ${input.nextAction} — ${input.reason}. Kỳ trước${when} xếp ${input.prevAction}`,
    );
  }
  parts.push(...input.alerts);
  return parts.map((p) => p.replace(/\.+$/, "")).join(". ");
}

export function hasAlert(adjustments: string): boolean {
  return adjustments.includes("ALERT");
}
