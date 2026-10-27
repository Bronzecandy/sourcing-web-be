import { matchPublisher, scaleLabel } from "./radar-rules";
import { hasAnyTiming, hasFutureDate, scheduleSignature } from "./radar-schedule";
import {
  actionFamily,
  actionRank,
  needsScreening,
  type RadarBullet,
  type RadarCarryOver,
  type RadarCountRow,
  type RadarRowPayload,
  type RadarSection3,
  type RadarSummary,
} from "./radar-types";

/** Tên cột bảng đếm giống report thật (1001, 0929). */
export const COUNT_KEYS = [
  "Test Viable",
  "Monitor - High",
  "Monitor - Mid",
  "Monitor - Low",
  "Temp. Ignore",
  "Drop",
] as const;

export const LABEL_DEFINITIONS = [
  "Test Viable: Game có tiềm năng, đã ra mắt chính thức hoặc mở open beta, có thể lên lịch test ngay. Đi kèm sub-tier High/Medium/Low Potential.",
  "Monitor: Game có tiềm năng, nhưng hiện chưa thể test hoặc chưa công bố thời gian ra mắt cụ thể. Đi kèm sub-tier High/Mid/Low Potential.",
  "High Potential: Game có chỉ số cao (trên 1 triệu), NPH top-tier, dòng game phù hợp, không dính redflag, tiềm năng tốt — bao gồm cả game đã có lịch test/ra mắt cụ thể trong thời gian tới LẪN game chưa có lịch cụ thể nhưng đạt đủ tiêu chí điểm/chỉ số/NPH.",
  "Mid/Medium Potential: Điểm potential khá (trên 75), lượt tải/đặt trước ở mức khá (trên 500K), không có barrier lớn về nội dung, cấu hình, flag.",
  "Low Potential: Điểm potential và lượt tải/đặt trước ở mức trung bình (trên 65, trên 100K), hoặc dù điểm/chỉ số cao nhưng có barrier lớn về nội dung/cấu hình/flag (vd cấu hình yêu cầu quá cao, hoặc đã có bên phát hành/bản phát hành quốc tế-Steam tại Việt Nam).",
  "Temporary Ignore: Game thuộc dòng phù hợp nhưng chỉ số vẫn chưa cao, có thể tạm bỏ qua.",
  "Drop: Game có barrier rõ ràng (chủ đề nhạy cảm, gameplay niche hoặc không phù hợp với thị trường), khó có cơ hội phát hành thành công.",
];

export function countBucket(action: string): (typeof COUNT_KEYS)[number] {
  const family = actionFamily(action);
  if (family === "viable") return "Test Viable";
  if (family === "high") return "Monitor - High";
  if (family === "mid") return "Monitor - Mid";
  if (family === "low") return "Monitor - Low";
  if (family === "ignore") return "Temp. Ignore";
  return "Drop";
}

/** "2026-10-26" → "26/10" như nhãn bảng đếm trong report. */
export function shortDayMonth(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${Number(d)}/${Number(m)}`;
}

function emptyCounts(): Record<string, number> {
  return Object.fromEntries(COUNT_KEYS.map((k) => [k, 0]));
}

function addUnique(rows: RadarRowPayload[]): Record<string, number> {
  const counts = emptyCounts();
  const seen = new Set<number>();
  for (const row of rows) {
    if (seen.has(row.appId)) continue;
    seen.add(row.appId);
    const key = countBucket(row.nextAction);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function buildCounts(rows: RadarRowPayload[], dayMonth: string): RadarCountRow[] {
  const reserve = rows.filter((r) => r.board === "reserve_growth" || r.board === "reserve_scale");
  const launch = rows.filter((r) => r.board === "new_launch");
  const reserveCounts = addUnique(reserve);
  const launchCounts = addUnique(launch);
  const total = emptyCounts();
  for (const key of COUNT_KEYS) total[key] = (reserveCounts[key] ?? 0) + (launchCounts[key] ?? 0);
  return [
    { label: `Reserve (${dayMonth})`, counts: reserveCounts },
    { label: `New Launch (${dayMonth})`, counts: launchCounts },
    { label: "TỔNG", counts: total },
  ];
}

export function displayName(row: Pick<RadarRowPayload, "title" | "titleEn">): string {
  return row.titleEn ? `${row.title} (${row.titleEn})` : row.title;
}

/** Một dòng / game, lấy dòng điểm cao nhất khi game có ở cả Growth và Scale. */
export function uniqueGames(rows: RadarRowPayload[]): RadarRowPayload[] {
  const byApp = new Map<number, RadarRowPayload>();
  for (const row of rows) {
    const prev = byApp.get(row.appId);
    if (!prev || row.score > prev.score) byApp.set(row.appId, row);
  }
  return [...byApp.values()];
}

function byActionThenScore(a: RadarRowPayload, b: RadarRowPayload): number {
  return actionRank(a.nextAction) - actionRank(b.nextAction) || b.score - a.score;
}

/** Bảng tổng quan Phần 1: Test Viable → High → Mid → Low, trong nhóm theo điểm giảm dần. */
export function overviewGames(rows: RadarRowPayload[]): RadarRowPayload[] {
  return uniqueGames(rows).filter((r) => needsScreening(r.nextAction)).sort(byActionThenScore);
}

export function playableNowGames(rows: RadarRowPayload[]): RadarRowPayload[] {
  return uniqueGames(rows)
    .filter((r) => r.nextAction.startsWith("Test Viable"))
    .sort((a, b) => b.score - a.score);
}

/** "Game sắp có thể test": Monitor có mốc tương lai cụ thể (open beta / closed beta / ra mắt). */
export function upcomingGames(rows: RadarRowPayload[], todayIso: string): RadarRowPayload[] {
  return uniqueGames(rows)
    .filter((r) => r.nextAction.startsWith("Monitor"))
    .filter((r) => (r.schedule ? hasFutureDate(r.schedule, todayIso) : Boolean(r.releaseLabel)))
    .sort((a, b) => b.score - a.score);
}

function monitorNoTiming(rows: RadarRowPayload[]): number {
  return uniqueGames(rows).filter(
    (r) => r.nextAction.startsWith("Monitor") && (r.schedule ? !hasAnyTiming(r.schedule) : !r.releaseLabel),
  ).length;
}

export function scaleText(row: RadarRowPayload): string {
  return row.metrics ? scaleLabel(row.metrics) : "—";
}

/** Phần 1 "Game hiện có thể test": "Tên — Đã ra mắt dd/mm/yyyy – Low Potential[, test nội bộ]". */
export function playableNowLine(row: RadarRowPayload): string {
  const tier = row.nextAction.replace(/^Test Viable - /, "");
  const parts = [`${displayName(row)} — ${row.releaseLabel || "đang chơi được"} – ${tier}`];
  if (row.internalTest?.label) parts.push(row.internalTest.label);
  return parts.join(", ");
}

/** Trường "Lý do" Phần 2: lý do bề mặt + điểm + rating. */
export function reasonDetail(row: RadarRowPayload): string {
  const bits = [row.reason || "—", `điểm ${row.score.toFixed(1)}`];
  const rating = row.metrics?.rating;
  if (rating) bits.push(`rating ${rating}`);
  return bits.join("; ");
}

function clean(text: string | undefined): string {
  return (text ?? "").trim().replace(/\.+$/, "");
}

function shortDesc(row: RadarRowPayload): string {
  const genre = clean(row.genre) || "—";
  const publisher = clean(row.publisher);
  return publisher ? `${genre}, ${publisher}` : genre;
}

function internalLabel(row: RadarRowPayload): string {
  return row.internalTest?.label || "Chưa lên plan test nội bộ";
}

function bullet(row: RadarRowPayload, text: string, opts: { isNew?: boolean; repeat?: boolean } = {}): RadarBullet {
  return {
    appId: row.appId,
    nameCn: row.title,
    nameEn: row.titleEn ?? "",
    overviewUrl: row.overviewUrl,
    text,
    isNew: opts.isNew ?? false,
    repeat: opts.repeat ?? false,
  };
}

function isInternational(row: RadarRowPayload): boolean {
  return Boolean(row.flags?.internationalRelease) || /quốc tế|Steam/.test(row.reason ?? "");
}

export function buildSection3(rows: RadarRowPayload[], prevRows: RadarRowPayload[], todayIso: string): RadarSection3 {
  const games = uniqueGames(rows).filter((r) => needsScreening(r.nextAction)).sort(byActionThenScore);
  const prevByApp = new Map(uniqueGames(prevRows).map((r) => [r.appId, r]));
  const isRepeat = (r: RadarRowPayload): boolean => {
    const p = prevByApp.get(r.appId);
    if (!p || r.newThisPeriod || r.scheduleChanged) return false;
    return (
      p.nextAction === r.nextAction &&
      (p.releaseLabel ?? "") === (r.releaseLabel ?? "") &&
      scheduleSignature(p.schedule) === scheduleSignature(r.schedule)
    );
  };

  const newEntries = games
    .filter((r) => r.newThisPeriod)
    .map((r) =>
      bullet(r, `: ${shortDesc(r)}. Chỉ số: ${scaleText(r)}. Trạng thái: ${r.nextAction}.`, { isNew: true }),
    );

  const scheduleUpdates = games
    .filter((r) => r.scheduleChanged || hasFutureDate(r.schedule, todayIso))
    .map((r) =>
      isRepeat(r)
        ? bullet(r, " - (đã có ở báo cáo trước)", { repeat: true })
        : bullet(r, `: ${r.scheduleChangeNote || r.releaseLabel}. Trạng thái: ${r.nextAction}.`, {
            isNew: r.newThisPeriod,
          }),
    );

  const testable = games
    .filter((r) => r.nextAction.startsWith("Test Viable"))
    .map((r) =>
      bullet(
        r,
        ` — ${shortDesc(r)}, ${scaleText(r)}, ${r.releaseLabel || "đang chơi được"}. ${internalLabel(r)}.`,
        { isNew: r.newThisPeriod },
      ),
    );

  const blocks = new Map<string, RadarBullet[]>();
  const order: string[] = [];
  const international: RadarBullet[] = [];
  for (const r of games) {
    const repeat = isRepeat(r);
    const text = repeat
      ? " - (đã có ở báo cáo trước)"
      : ` — ${clean(r.genre) || "—"}. ${r.nextAction} (${scaleText(r)}). ${r.releaseLabel || "Chưa công bố lịch"}.`;
    const item = bullet(r, text, { isNew: r.newThisPeriod && !repeat, repeat });
    if (isInternational(r)) {
      international.push(item);
      continue;
    }
    const publisher = matchPublisher(r.publisher);
    if (!publisher) continue;
    if (!blocks.has(publisher.name)) {
      blocks.set(publisher.name, []);
      order.push(publisher.name);
    }
    blocks.get(publisher.name)!.push(item);
  }
  const market = order.map((name) => ({ publisher: name, items: blocks.get(name)! }));
  if (international.length > 0) market.push({ publisher: "Nhóm game phát hành quốc tế/Steam", items: international });

  return { newEntries, scheduleUpdates, testable, market };
}

export function buildRadarSummary(input: {
  todayIso: string;
  dateLabel: string;
  periodCode: string;
  rows: RadarRowPayload[];
  prevRows: RadarRowPayload[];
  prevDate: string | null;
  prevPeriodCode: string | null;
  carryOver: RadarCarryOver[];
  testingThisWeek: string[];
}): RadarSummary {
  const { rows, todayIso } = input;
  const testableNow = playableNowGames(rows).map((r) => `${playableNowLine(r)}\n${r.overviewUrl}`);
  const upcoming = upcomingGames(rows, todayIso).map(
    (r) => `${displayName(r)} — ${r.releaseLabel}\n${r.overviewUrl}`,
  );
  const summary: RadarSummary = {
    periodCode: input.periodCode,
    dateLabel: input.dateLabel,
    copyText: "",
    executiveParagraphs: [],
    testableNow,
    upcoming,
    monitorNoDateCount: monitorNoTiming(rows),
    counts: buildCounts(rows, shortDayMonth(todayIso)),
    previousDate: input.prevDate,
    previousPeriodCode: input.prevPeriodCode,
    testingThisWeek: input.testingThisWeek,
    section3: buildSection3(rows, input.prevRows, todayIso),
    carryOver: input.carryOver,
  };
  summary.copyText = buildCopyText(summary, rows, todayIso);
  return summary;
}

function mdCell(value: string, max = 160): string {
  const clean = value.replace(/\|/g, "/").replace(/\s+/g, " ").trim();
  if (!clean) return "—";
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function markdownTable(headers: string[], body: string[][]): string {
  const head = `| ${headers.map((h) => mdCell(h, 40)).join(" | ")} |`;
  const rule = `| ${headers.map(() => "---").join(" | ")} |`;
  const lines = body.map((row) => `| ${row.map((cell) => mdCell(cell)).join(" | ")} |`);
  return [head, rule, ...lines].join("\n");
}

function bulletLine(b: RadarBullet): string {
  const name = b.nameEn ? `${b.nameCn} (${b.nameEn})` : b.nameCn;
  return `- ${b.isNew ? "**MỚI —** " : ""}**${name}**${b.text}`;
}

function screeningShort(row: RadarRowPayload): string {
  if (!row.screeningUrl) return "AI: chưa có";
  return row.analysisScore != null ? `AI ${Math.round(row.analysisScore)}` : "AI: có";
}

function overviewLine(row: RadarRowPayload): string[] {
  const parts = [
    `Điểm ${row.score.toFixed(1)}`,
    screeningShort(row),
    row.genre || "—",
    row.publisher ? `NPH **${row.publisher}**` : "",
    row.releaseLabel || "",
  ].filter(Boolean);
  return [`- **${displayName(row)}** — ${parts.join(" · ")}`, `  Lý do: ${reasonDetail(row)}`, `  ${row.overviewUrl}`];
}

export function buildCopyText(summary: RadarSummary, rows: RadarRowPayload[], todayIso: string): string {
  const lines: string[] = [
    "**GAME RADAR & TESTING RECAP**",
    `Executive Summary — Kỳ ${summary.periodCode} (${summary.dateLabel})`,
    "",
    "**1. Overview**",
    "",
    "**Số liệu nhanh:**",
  ];
  if (summary.testingThisWeek && summary.testingThisWeek.length > 0) {
    lines.push("**Game đang test trong tuần:**", ...summary.testingThisWeek.map((t) => `- ${t}`));
  }
  const now = playableNowGames(rows);
  lines.push("**Game hiện có thể test:**");
  if (now.length === 0) lines.push("- Không có game nào đang mở test/đã ra mắt tại thời điểm chốt kỳ.");
  for (const r of now) lines.push(`- ${playableNowLine(r)}`);
  lines.push(`**Game Monitor chưa có thời gian:** ${summary.monitorNoDateCount}`, "");

  lines.push(
    "**Bảng đếm số lượng game theo Next Action:**",
    "",
    markdownTable(
      ["Bảng", ...COUNT_KEYS],
      summary.counts.map((c) => [c.label, ...COUNT_KEYS.map((k) => String(c.counts[k] ?? 0))]),
    ),
    "",
    "**Bảng tổng quan — toàn bộ game đang ở Test Viable / Monitor trong kỳ:**",
    "",
  );
  const overview = overviewGames(rows);
  lines.push(
    overview.length === 0
      ? "Không có game Test Viable hoặc Monitor trong kỳ này."
      : markdownTable(["Tên game", "Next Action"], overview.map((r) => [displayName(r), r.nextAction])),
  );

  lines.push("", "**2. Game Overview**", "", "**Game hiện có thể test:**");
  if (now.length === 0) lines.push("- Không có");
  for (const r of now) lines.push(...overviewLine(r));
  const upcoming = upcomingGames(rows, todayIso);
  lines.push("", "**Game sắp có thể test:**");
  if (upcoming.length === 0) lines.push("- Không có");
  for (const r of upcoming) lines.push(...overviewLine(r));

  const s3 = summary.section3;
  lines.push("", "**3. Executive Summary**", "", "**Biến động đáng chú ý trong tuần:**", "Mới xuất hiện:");
  if (!s3 || s3.newEntries.length === 0) lines.push("- Không có game mới cần Monitor trong kỳ này.");
  else lines.push(...s3.newEntries.map(bulletLine));
  lines.push("Cập nhật lịch trình mới:");
  if (!s3 || s3.scheduleUpdates.length === 0) lines.push("- Không có lịch ra mắt/test mới trong kỳ này.");
  else lines.push(...s3.scheduleUpdates.map(bulletLine));
  lines.push("", "**Game có thể test:**");
  if (!s3 || s3.testable.length === 0) lines.push("- Không có game nào ở mức Test Viable trong kỳ này.");
  else lines.push(...s3.testable.map(bulletLine));
  lines.push("", "**Thông tin game thị trường mới**");
  if (!s3 || s3.market.length === 0) lines.push("- Không có game của NPH lớn trong kỳ này.");
  for (const block of s3?.market ?? []) {
    lines.push(`**${block.publisher}**`, ...block.items.map(bulletLine));
  }
  lines.push(
    "",
    `File đính kèm: Executive Summary - Radar ${summary.periodCode}.docx và Game Radar Recap ${summary.periodCode}.xlsx.`,
  );
  return lines.join("\n").trim() + "\n";
}

const SECTION_MARKERS = ["**2. Game Overview**", "**3. Executive Summary**"];

export function buildSeatalkMessages(copyText: string, limit = 3900): string[] {
  const parts: string[] = [];
  let rest = copyText;
  for (const marker of SECTION_MARKERS) {
    const idx = rest.indexOf(marker);
    if (idx <= 0) continue;
    parts.push(rest.slice(0, idx).trim());
    rest = rest.slice(idx);
  }
  parts.push(rest.trim());

  const chunks: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    if (part.length <= limit) {
      chunks.push(part);
      continue;
    }
    let buf = "";
    for (const line of part.split("\n")) {
      const next = buf ? `${buf}\n${line}` : line;
      if (next.length > limit) {
        if (buf) chunks.push(buf);
        buf = line.length <= limit ? line : `${line.slice(0, limit - 10)}…`;
      } else {
        buf = next;
      }
    }
    if (buf) chunks.push(buf);
  }
  return chunks.filter(Boolean);
}
