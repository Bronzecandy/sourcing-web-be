import { matchPublisher, scaleLabel } from "./radar-rules";
import {
  PRIORITY_ORDER,
  boardLabel,
  potentialLevel,
  priorityRank,
  type RadarCountRow,
  type RadarDigest,
  type RadarDigestGroup,
  type RadarDigestLine,
  type RadarRowPayload,
} from "./radar-types";

const DAY_MS = 86_400_000;
/** Mốc test/ra mắt chưa đổi trong kỳ vẫn lên Executive Summary khi còn trong khoảng này. */
const SOON_DAYS = 45;
/** Đợt tuyển test/closed beta bắt đầu quá số ngày này coi như cũ. */
const STALE_TEST_DAYS = 30;

interface Game {
  /** Dòng điểm cao nhất khi game có ở nhiều bảng. */
  row: RadarRowPayload;
  boards: Array<{ board: string; rank: number }>;
}

function gamesOf(rows: RadarRowPayload[]): Game[] {
  const byApp = new Map<number, Game>();
  for (const row of rows) {
    const game = byApp.get(row.appId);
    if (!game) {
      byApp.set(row.appId, { row, boards: [{ board: row.board, rank: row.rank }] });
      continue;
    }
    game.boards.push({ board: row.board, rank: row.rank });
    if (row.score > game.row.score) game.row = row;
  }
  return [...byApp.values()].sort(
    (a, b) => priorityRank(a.row.nextAction) - priorityRank(b.row.nextAction) || b.row.score - a.row.score,
  );
}

function nameOf(row: Pick<RadarRowPayload, "title" | "titleEn">): string {
  return row.titleEn ? `${row.title} (${row.titleEn})` : row.title;
}

function boardsText(game: Game): string {
  return [...game.boards]
    .sort((a, b) => a.board.localeCompare(b.board) || a.rank - b.rank)
    .map((b) => `${boardLabel(b.board)} #${b.rank}`)
    .join(" · ");
}

function shortAction(action: string): string {
  return action.replace(/ Potential$/, "").replace("Temporary Ignore", "Temp. Ignore");
}

function daysUntil(todayIso: string, iso: string): number {
  return Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / DAY_MS);
}

function countdown(todayIso: string, iso: string | null | undefined): string {
  if (!iso) return "";
  const days = daysUntil(todayIso, iso);
  if (days > 0) return ` (còn ${days} ngày)`;
  return days === 0 ? " (hôm nay)" : "";
}

/** Đợt test đang mở hoặc mốc test/ra mắt trong SOON_DAYS ngày tới. */
function windowNote(row: RadarRowPayload, todayIso: string): string | null {
  const s = row.schedule;
  if (!s?.kind || s.kind === "launched" || s.kind === "open_beta" || s.kind === "event") return null;
  const label = s.label || row.releaseLabel || "";
  if (!label) return null;
  if (!s.date) return s.kind === "test_recruit" || s.kind === "test_running" ? label : null;
  const days = daysUntil(todayIso, s.date);
  if (days > SOON_DAYS || days < -STALE_TEST_DAYS) return null;
  if (days >= 0) return `${label}${countdown(todayIso, s.date)}`;
  return s.kind === "launch_date" ? null : `${label} (${-days} ngày trước)`;
}

function capitalize(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}

function topPublisher(row: RadarRowPayload): string | null {
  const hit = matchPublisher(row.publisher);
  return hit?.topTier ? hit.name : null;
}

/** Game Mid/Medium không có thẻ Game Overview nên kèm quy mô và điểm. */
function midFacts(row: RadarRowPayload): string {
  return [row.metrics ? scaleLabel(row.metrics) : null, `điểm ${row.score.toFixed(1)}`].filter(Boolean).join(" · ");
}

function upgradedFrom(row: RadarRowPayload): string | null {
  if (row.newThisPeriod || !row.previousAction) return null;
  return priorityRank(row.nextAction) < priorityRank(row.previousAction) ? row.previousAction : null;
}

function line(game: Game, note: string): RadarDigestLine {
  const r = game.row;
  return {
    appId: r.appId,
    name: nameOf(r),
    url: r.overviewUrl,
    nextAction: r.nextAction,
    note,
    publisher: topPublisher(r),
    card: potentialLevel(r.nextAction) === "high",
  };
}

function countRows(rows: RadarRowPayload[], todayIso: string): RadarCountRow[] {
  const tally = (list: RadarRowPayload[]) => {
    const counts: Record<string, number> = Object.fromEntries(PRIORITY_ORDER.map((a) => [a, 0]));
    for (const g of gamesOf(list)) counts[g.row.nextAction] = (counts[g.row.nextAction] ?? 0) + 1;
    return counts;
  };
  const reserve = tally(rows.filter((r) => r.board !== "new_launch"));
  const launch = tally(rows.filter((r) => r.board === "new_launch"));
  const total = Object.fromEntries(PRIORITY_ORDER.map((a) => [a, (reserve[a] ?? 0) + (launch[a] ?? 0)]));
  const [, m, d] = todayIso.split("-");
  const dm = `${Number(d)}/${Number(m)}`;
  return [
    { label: `Reserve (${dm})`, counts: reserve },
    { label: `New Launch (${dm})`, counts: launch },
    { label: "TỔNG", counts: total },
  ];
}

export function buildRadarDigest(input: {
  rows: RadarRowPayload[];
  prevRows: RadarRowPayload[];
  todayIso: string;
  testingThisWeek: string[];
}): RadarDigest {
  const { todayIso } = input;
  const games = gamesOf(input.rows);
  const level = (g: Game) => potentialLevel(g.row.nextAction);
  const viable = (g: Game) => g.row.nextAction.startsWith("Test Viable");
  const good = (g: Game) => level(g) === "high" || level(g) === "mid";
  const notable = (g: Game) => Boolean(g.row.newThisPeriod || g.row.scheduleChanged);

  const used = new Set<number>();
  const groups: RadarDigestGroup[] = [];
  const pick = (candidates: Game[], note: (g: Game) => string): RadarDigestLine[] => {
    const lines = candidates.filter((g) => !used.has(g.row.appId)).map((g) => line(g, note(g)));
    for (const l of lines) used.add(l.appId);
    return lines;
  };

  const testable = pick(
    games.filter((g) => viable(g) && (level(g) === "high" || (level(g) === "mid" && notable(g)))),
    (g) =>
      [
        g.row.newThisPeriod ? "mới vào radar" : null,
        g.row.releaseLabel || "đang chơi được",
        g.row.internalTest?.label || "chưa có plan test nội bộ",
        level(g) === "high" ? null : midFacts(g.row),
      ]
        .filter(Boolean)
        .join(" · "),
  );
  groups.push({
    key: "testable",
    title: "Test được ngay",
    lines: testable,
    empty: "Chưa có game High Potential nào chơi/test được ngay.",
  });

  const schedule = pick(
    games.filter(
      (g) =>
        !viable(g) &&
        ((level(g) === "high" && (g.row.scheduleChanged || windowNote(g.row, todayIso))) ||
          (level(g) === "mid" && g.row.scheduleChanged)),
    ),
    (g) => {
      const r = g.row;
      const what =
        r.scheduleChanged && r.scheduleChangeNote
          ? `${capitalize(r.scheduleChangeNote)}${countdown(todayIso, r.schedule?.date)}`
          : (windowNote(r, todayIso) ?? r.releaseLabel);
      return [what, r.newThisPeriod ? "mới vào radar" : null, level(g) === "high" ? null : midFacts(r)]
        .filter(Boolean)
        .join(" · ");
    },
  );
  if (schedule.length) groups.push({ key: "schedule", title: "Lịch test / ra mắt", lines: schedule });

  const fresh = pick(
    games.filter((g) => g.row.newThisPeriod && good(g)),
    (g) =>
      [`vào ${boardsText(g)}`, g.row.releaseLabel || null, level(g) === "high" ? null : midFacts(g.row)]
        .filter(Boolean)
        .join(" · "),
  );
  if (fresh.length) groups.push({ key: "new", title: "Mới vào radar", lines: fresh });

  const upgraded = pick(
    games.filter((g) => level(g) === "high" && upgradedFrom(g.row)),
    (g) => [`lên từ ${upgradedFrom(g.row)}`, g.row.releaseLabel || null].filter(Boolean).join(" · "),
  );
  if (upgraded.length) groups.push({ key: "upgraded", title: "Lên hạng", lines: upgraded });

  const current = new Map(games.map((g) => [g.row.appId, g]));
  const downgraded: RadarDigestLine[] = [];
  for (const prev of gamesOf(input.prevRows)) {
    if (potentialLevel(prev.row.nextAction) !== "high" || used.has(prev.row.appId)) continue;
    const now = current.get(prev.row.appId);
    if (!now) {
      downgraded.push({ ...line(prev, `rời Top 20 (kỳ trước: ${prev.row.nextAction})`), nextAction: "", card: false });
    } else if (level(now) !== "high") {
      downgraded.push({ ...line(now, `${prev.row.nextAction} → ${now.row.nextAction}`), nextAction: "" });
    } else {
      continue;
    }
    used.add(prev.row.appId);
  }
  if (downgraded.length) groups.push({ key: "downgraded", title: "Rời nhóm High", lines: downgraded });

  const high = games.filter((g) => level(g) === "high");
  const quiet = high
    .filter((g) => !used.has(g.row.appId))
    .map((g) => line(g, g.row.releaseLabel || "chưa công bố lịch"));
  for (const l of quiet) used.add(l.appId);

  const rest = new Map<string, number>();
  for (const g of games) {
    if (used.has(g.row.appId)) continue;
    rest.set(g.row.nextAction, (rest.get(g.row.nextAction) ?? 0) + 1);
  }
  const others = [...rest.entries()]
    .sort((a, b) => priorityRank(a[0]) - priorityRank(b[0]))
    .map(([action, n]) => `${n} ${action}`)
    .join(", ");

  const midNotable = groups.flatMap((g) => g.lines).filter((l) => potentialLevel(l.nextAction) === "mid").length;
  return {
    stats: [
      { key: "high", label: "High Potential", value: high.length },
      { key: "testable", label: "Test được ngay", value: testable.length },
      { key: "mid", label: "Mid/Medium có biến động", value: midNotable },
      { key: "internal", label: "Đang test nội bộ", value: input.testingThisWeek.length },
    ],
    internalTests: input.testingThisWeek,
    groups,
    quiet,
    others: others || null,
    cards: high.map((g) => ({
      appId: g.row.appId,
      boards: boardsText(g),
      badges: [
        g.row.newThisPeriod ? "Mới vào radar" : null,
        g.row.scheduleChanged ? "Lịch mới" : null,
        upgradedFrom(g.row) ? `Lên từ ${shortAction(upgradedFrom(g.row)!)}` : null,
      ].filter((b): b is string => Boolean(b)),
    })),
    counts: { columns: [...PRIORITY_ORDER], rows: countRows(input.rows, todayIso) },
  };
}

function digestLineText(l: RadarDigestLine): string {
  const tail = [l.nextAction || null, l.publisher].filter(Boolean).join(" · ");
  return `- **${l.name}** — ${l.note}${tail ? ` · ${tail}` : ""}`;
}

/** Tin SeaTalk / nút "Copy để gửi": Executive Summary ngắn + link báo cáo web. */
export function digestCopyText(
  digest: RadarDigest,
  meta: { periodCode: string; dateLabel: string; previousPeriodCode?: string | null; reportUrl?: string | null },
): string {
  const lines = [
    `**GAME RADAR & TESTING RECAP — Kỳ ${meta.periodCode}**`,
    `Executive Summary ngày ${meta.dateLabel}${meta.previousPeriodCode ? ` (so với kỳ ${meta.previousPeriodCode})` : ""}`,
    "",
    digest.stats.map((s) => `${s.label}: **${s.value}**`).join(" · "),
  ];
  if (digest.internalTests.length > 0) {
    lines.push("", "**Đang test nội bộ:**", ...digest.internalTests.map((t) => `- ${t}`));
  }
  for (const group of digest.groups) {
    lines.push("", `**${group.title}:**`);
    if (group.lines.length === 0 && group.empty) lines.push(`- ${group.empty}`);
    lines.push(...group.lines.map(digestLineText));
  }
  if (digest.quiet.length > 0) {
    lines.push(
      "",
      `**Theo dõi tiếp (High Potential, chưa có biến động):** ${digest.quiet.map((l) => `${l.name} – ${l.note}`).join("; ")}`,
    );
  }
  if (digest.others) lines.push("", `Ngoài ra: ${digest.others}.`);
  lines.push("");
  if (meta.reportUrl) lines.push(`Báo cáo đầy đủ: ${meta.reportUrl}`);
  lines.push(`File đính kèm: Executive Summary - Radar ${meta.periodCode}.docx và Game Radar Recap ${meta.periodCode}.xlsx.`);
  return lines.join("\n").trim() + "\n";
}
