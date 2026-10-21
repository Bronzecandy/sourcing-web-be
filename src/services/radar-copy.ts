import { actionFamily, boardLabel, type RadarCountRow, type RadarRowPayload, type RadarSummary } from "./radar-types";

const COUNT_KEYS = [
  "Test Viable",
  "Monitor - High",
  "Monitor - Mid",
  "Monitor - Low",
  "Temp. Ignore",
  "Drop",
] as const;

export function countBucket(action: string): (typeof COUNT_KEYS)[number] {
  const family = actionFamily(action);
  if (family === "viable") return "Test Viable";
  if (family === "high") return "Monitor - High";
  if (family === "mid") return "Monitor - Mid";
  if (family === "low") return "Monitor - Low";
  if (family === "ignore") return "Temp. Ignore";
  return "Drop";
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

export function buildCounts(rows: RadarRowPayload[], dateLabel: string): RadarCountRow[] {
  const reserve = rows.filter((r) => r.board === "reserve_growth" || r.board === "reserve_scale");
  const launch = rows.filter((r) => r.board === "new_launch");
  const reserveCounts = addUnique(reserve);
  const launchCounts = addUnique(launch);
  const total = emptyCounts();
  for (const key of COUNT_KEYS) total[key] = (reserveCounts[key] ?? 0) + (launchCounts[key] ?? 0);
  return [
    { label: `Reserve (${dateLabel})`, counts: reserveCounts },
    { label: `New Launch (${dateLabel})`, counts: launchCounts },
    { label: "TỔNG", counts: total },
  ];
}

function displayName(row: RadarRowPayload): string {
  return row.titleEn ? `${row.title} (${row.titleEn})` : row.title;
}

export function buildCopyText(opts: {
  dateLabel: string;
  periodCode: string;
  rows: RadarRowPayload[];
  executiveParagraphs: string[];
}): { copyText: string; summary: Omit<RadarSummary, "copyText"> & { copyText: string } } {
  const counts = buildCounts(opts.rows, opts.dateLabel);
  const byApp = new Map<number, RadarRowPayload>();
  for (const row of opts.rows) {
    const prev = byApp.get(row.appId);
    if (!prev || row.score > prev.score) byApp.set(row.appId, row);
  }
  const unique = [...byApp.values()];
  const testableNow = unique
    .filter((r) => r.playableNow)
    .map((r) => {
      const when = r.releaseLabel ? ` — ${r.releaseLabel}` : "";
      const why = r.reason ? `, ${r.reason}` : "";
      return `${displayName(r)}${when}${why}\n${r.overviewUrl}`;
    });
  const upcoming = unique
    .filter((r) => !r.playableNow && r.releaseLabel)
    .map((r) => `${displayName(r)} — ${r.releaseLabel}${r.reason ? `, ${r.reason}` : ""}\n${r.overviewUrl}`);
  const monitorNoDateCount = unique.filter(
    (r) => r.nextAction.startsWith("Monitor") && !r.releaseLabel,
  ).length;

  const lines: string[] = [
    "GAME RADAR & TESTING RECAP",
    opts.dateLabel,
    "",
    "1. Overview",
    "Số liệu nhanh:",
    "Game hiện có thể test:",
    ...(testableNow.length ? testableNow.map((t) => `- ${t}`) : ["- Không có"]),
    `Game Monitor chưa có thời gian ra mắt: ${monitorNoDateCount}`,
    "",
    "Bảng đếm số lượng game theo Next Action:",
    ["Bảng", ...COUNT_KEYS].join("\t"),
    ...counts.map((c) => [c.label, ...COUNT_KEYS.map((k) => String(c.counts[k] ?? 0))].join("\t")),
    "",
    "2. Game Overview",
    "Game hiện có thể test:",
  ];

  const viable = unique.filter((r) => r.nextAction.startsWith("Test Viable"));
  if (viable.length === 0) lines.push("- Không có");
  for (const row of viable) {
    lines.push(
      `- ${displayName(row)} — ${row.nextAction}`,
      `  Thể loại: ${row.genre || "—"}`,
      `  Nhà phát hành: ${row.publisher || "—"}`,
      `  Lịch: ${row.releaseLabel || "—"}`,
      `  ${row.insights}`,
      `  ${row.overviewUrl}`,
    );
  }
  lines.push("", "Sắp có thể test / đang theo dõi:");
  const watch = unique.filter((r) => r.nextAction.startsWith("Monitor"));
  if (watch.length === 0) lines.push("- Không có");
  for (const row of watch) {
    lines.push(`- ${displayName(row)} — ${row.nextAction}${row.releaseLabel ? ` — ${row.releaseLabel}` : ""}`);
    lines.push(`  ${row.insights}`);
    lines.push(`  ${row.overviewUrl}`);
  }

  lines.push("", "3. Executive Summary");
  for (const p of opts.executiveParagraphs) lines.push(p, "");

  const copyText = lines.join("\n").trim() + "\n";
  return {
    copyText,
    summary: {
      periodCode: opts.periodCode,
      dateLabel: opts.dateLabel,
      copyText,
      executiveParagraphs: opts.executiveParagraphs,
      testableNow,
      upcoming,
      monitorNoDateCount,
      counts,
    },
  };
}

export { COUNT_KEYS };
