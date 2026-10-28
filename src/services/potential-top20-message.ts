import type { PotentialSegment } from "../types";

export const POTENTIAL_TOP20_DAYS = 14;
export const POTENTIAL_TOP20_PLATFORM = "combined" as const;
export const POTENTIAL_TOP20_LIMIT = 20;
export const POTENTIAL_TOP20_MESSAGE_MAX_CHARS = 4000;

export const POTENTIAL_ALERT_BOARDS = [
  {
    id: "reserve_growth",
    segment: "reserve" as PotentialSegment,
    sort: "momentum" as const,
    labelVi: "Reserve tăng trưởng",
  },
  {
    id: "reserve_scale",
    segment: "reserve" as PotentialSegment,
    sort: "composite" as const,
    labelVi: "Reserve quy mô",
  },
  {
    id: "launch_growth",
    segment: "launched" as PotentialSegment,
    sort: "momentum" as const,
    labelVi: "Launch tăng trưởng",
  },
  {
    id: "launch_scale",
    segment: "launched" as PotentialSegment,
    sort: "composite" as const,
    labelVi: "Launch quy mô",
  },
] as const;

export type PotentialAlertBoardId = (typeof POTENTIAL_ALERT_BOARDS)[number]["id"];

export interface PotentialTop20Entry {
  board: PotentialAlertBoardId;
  rank: number;
  appId: number;
  title: string;
  score: number;
}

/** Một game mới vào top 20 (có thể vào nhiều bảng cùng lúc). */
export interface PotentialAlertGame {
  appId: number;
  title: string;
  titleEn: string | null;
  boards: Array<{ board: PotentialAlertBoardId; rank: number; score: number }>;
  /** Chưa từng có trong top 20 của bảng nào. */
  firstEver: boolean;
  /** Ngày gần nhất có trong top 20 trước kỳ vắng (khi quay lại). */
  lastSeen: string | null;
  analysisId: string | null;
  analysisScore: number | null;
  analyzedAt: string | null;
}

const BOARD_LABEL = new Map<string, string>(POTENTIAL_ALERT_BOARDS.map((b) => [b.id, b.labelVi]));

function viDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function formatScore(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

export function messageHeader(dateLabel: string, lookbackDays: number): string {
  return (
    `**Potential: game mới vào top 20 (${viDate(dateLabel)})**\n` +
    `4 bảng Potential ${POTENTIAL_TOP20_DAYS} ngày (Android + iOS). ` +
    `Game mới = lần đầu vào top 20 hoặc vắng top 20 từ ${lookbackDays} ngày trở lên.`
  );
}

function gameBlock(g: PotentialAlertGame, index: number, dateLabel: string, publicUrl: string): string {
  const name = g.titleEn && g.titleEn !== g.title ? `${g.title} (${g.titleEn})` : g.title;
  const boards = g.boards.map((b) => `${BOARD_LABEL.get(b.board) ?? b.board} #${b.rank}`).join(", ");
  const status = g.firstEver
    ? "Lần đầu vào top 20"
    : g.lastSeen
      ? `Quay lại sau ${daysBetween(g.lastSeen, dateLabel)} ngày (lần cuối ${viDate(g.lastSeen)})`
      : "Quay lại top 20";
  const best = Math.max(...g.boards.map((b) => b.score));
  const ai =
    g.analysisId != null
      ? `Phân tích AI: ${g.analysisScore != null ? `${Math.round(g.analysisScore)}/100` : "xem chi tiết"}`
      : "Chưa có phân tích AI";
  const lines = [
    `**${index}. ${name}**`,
    `${boards} · ${status}`,
    `Điểm Potential ${formatScore(best)} · ${ai}`,
  ];
  if (g.analysisId) lines.push(`${publicUrl}/ai-analysis/a/${g.analysisId}`);
  lines.push(`Trang game: ${publicUrl}/game/${g.appId}`);
  return lines.join("\n");
}

function chunk(header: string, blocks: string[]): string[] {
  const out: string[] = [];
  let current = header;
  for (const block of blocks) {
    const next = `${current}\n\n${block}`;
    if (next.length <= POTENTIAL_TOP20_MESSAGE_MAX_CHARS) {
      current = next;
      continue;
    }
    if (current !== header) out.push(current);
    current = `${header}\n\n${block}`.slice(0, POTENTIAL_TOP20_MESSAGE_MAX_CHARS);
  }
  if (current !== header) out.push(current);
  return out;
}

export function formatPotentialAlertMessages(opts: {
  dateLabel: string;
  games: PotentialAlertGame[];
  publicUrl: string;
  lookbackDays: number;
}): string[] {
  const header = messageHeader(opts.dateLabel, opts.lookbackDays);
  if (opts.games.length === 0) {
    return [`${header}\n\nHôm nay không có game mới vào top 20.`];
  }
  const blocks = opts.games.map((g, i) => gameBlock(g, i + 1, opts.dateLabel, opts.publicUrl));
  return chunk(`${header}\n${opts.games.length} game mới:`, blocks);
}

export function formatStaleMessage(dateLabel: string, prevDate: string): string {
  return (
    `**Potential: game mới vào top 20 (${viDate(dateLabel)})**\n` +
    `Dữ liệu Potential hôm nay trùng 100% với ngày ${viDate(prevDate)} (cùng game, cùng hạng, cùng điểm), ` +
    `nên chưa xét được game mới. Hệ thống thử lại ở lần chạy sau.`
  );
}
