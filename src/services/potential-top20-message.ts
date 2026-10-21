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

export interface PotentialTop20Newcomer extends PotentialTop20Entry {
  firstEver: boolean;
  analysisId?: string | null;
}

export function messageHeader(dateLabel: string): string {
  return `Potential top 20 — ${dateLabel}\nCửa sổ ${POTENTIAL_TOP20_DAYS} ngày · ${POTENTIAL_TOP20_PLATFORM}`;
}

function formatScore(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function gameBlock(n: PotentialTop20Newcomer, publicUrl: string): string {
  const flag = n.firstEver ? "lần đầu" : "đã từng vào";
  const path = n.analysisId ? `/ai-analysis/a/${n.analysisId}` : `/game/${n.appId}`;
  return `#${n.rank} ${n.title} — ${flag} — ${formatScore(n.score)}\n${publicUrl}${path}`;
}

function appendChunks(out: string[], header: string, pieces: string[]): void {
  let current = header;
  for (const piece of pieces) {
    const next = `${current}\n\n${piece}`;
    if (next.length <= POTENTIAL_TOP20_MESSAGE_MAX_CHARS) {
      current = next;
      continue;
    }
    if (current !== header) out.push(current);
    const alone = `${header}\n\n${piece}`;
    if (alone.length <= POTENTIAL_TOP20_MESSAGE_MAX_CHARS) {
      current = alone;
    } else {
      out.push(alone.slice(0, POTENTIAL_TOP20_MESSAGE_MAX_CHARS));
      current = header;
    }
  }
  if (current !== header) out.push(current);
}

export function formatPotentialTop20Messages(opts: {
  dateLabel: string;
  newcomers: PotentialTop20Newcomer[];
  publicUrl: string;
}): string[] {
  const header = messageHeader(opts.dateLabel);
  if (opts.newcomers.length === 0) {
    return [`${header}\n\nKhông có game mới vào top 20.`];
  }

  const sections: string[] = [];
  for (const board of POTENTIAL_ALERT_BOARDS) {
    const rows = opts.newcomers
      .filter((n) => n.board === board.id)
      .sort((a, b) => a.rank - b.rank);
    if (rows.length === 0) continue;
    const games = rows.map((n) => gameBlock(n, opts.publicUrl)).join("\n\n");
    sections.push(`[${board.labelVi}]\n${games}`);
  }

  const joined = [header, ...sections].join("\n\n");
  if (joined.length <= POTENTIAL_TOP20_MESSAGE_MAX_CHARS) return [joined];

  const out: string[] = [];
  for (const board of POTENTIAL_ALERT_BOARDS) {
    const rows = opts.newcomers
      .filter((n) => n.board === board.id)
      .sort((a, b) => a.rank - b.rank);
    if (rows.length === 0) continue;
    const title = `[${board.labelVi}]`;
    const section = `${title}\n${rows.map((n) => gameBlock(n, opts.publicUrl)).join("\n\n")}`;
    if (`${header}\n\n${section}`.length <= POTENTIAL_TOP20_MESSAGE_MAX_CHARS) {
      out.push(`${header}\n\n${section}`);
    } else {
      appendChunks(
        out,
        header,
        rows.map((n) => `${title}\n${gameBlock(n, opts.publicUrl)}`),
      );
    }
  }
  return out.length > 0 ? out : [joined.slice(0, POTENTIAL_TOP20_MESSAGE_MAX_CHARS)];
}
