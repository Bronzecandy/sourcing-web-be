import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  LineRuleType,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from "docx";
import ExcelJS from "exceljs";
import {
  COUNT_KEYS,
  LABEL_DEFINITIONS,
  overviewGames,
  playableNowGames,
  playableNowLine,
  reasonDetail,
  upcomingGames,
} from "./radar-copy";
import { hasAlert, scaleLabel } from "./radar-rules";
import {
  RADAR_BOARDS,
  needsScreening,
  type RadarBullet,
  type RadarRowPayload,
  type RadarSummary,
} from "./radar-types";

const SPACING = {
  bullet: { after: 140, line: 300, lineRule: LineRuleType.EXACT },
  subheading: { before: 220, after: 100 },
  tableCell: { after: 120 },
};

const COLORS = {
  test: "9DC3E6",
  high: "A9D18E",
  mid: "C6E0B4",
  low: "FFE699",
  ignore: "FFD9A0",
  drop: "FFC7CE",
};

const ALERT_FILL = "FFF2CC";

function colorFor(status: string): string {
  if (status.startsWith("Test Viable")) return COLORS.test;
  if (status === "Monitor - High Potential") return COLORS.high;
  if (status === "Monitor - Mid Potential") return COLORS.mid;
  if (status === "Monitor - Low Potential") return COLORS.low;
  if (status === "Temporary Ignore") return COLORS.ignore;
  if (status === "Drop") return COLORS.drop;
  return "FFFFFF";
}

type Runs = Array<TextRun | ExternalHyperlink>;

function gameLink(cn: string, en: string, url: string): ExternalHyperlink {
  return new ExternalHyperlink({
    link: url,
    children: [new TextRun({ text: en ? `${cn} (${en})` : cn, bold: true, style: "Hyperlink" })],
  });
}

function rowLink(row: RadarRowPayload): ExternalHyperlink {
  return gameLink(row.title, row.titleEn ?? "", row.overviewUrl);
}

function bulletP(children: Runs, level = 0): Paragraph {
  return new Paragraph({ numbering: { reference: "bullets", level }, spacing: { ...SPACING.bullet }, children });
}

function h1(text: string): Paragraph {
  return new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(text)] });
}

function h2(text: string): Paragraph {
  return new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(text)] });
}

function h3(children: Runs): Paragraph {
  return new Paragraph({ heading: HeadingLevel.HEADING_3, children });
}

function p(text: string): Paragraph {
  return new Paragraph({ children: [new TextRun(text)], spacing: { ...SPACING.subheading } });
}

function nphTitle(title: string): Paragraph {
  return new Paragraph({ children: [new TextRun({ text: title, bold: true })], spacing: { ...SPACING.subheading } });
}

function divider(): Paragraph {
  return new Paragraph({
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "BFBFBF", space: 1 } },
    spacing: { before: 40, after: 240 },
    children: [],
  });
}

const border = { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" };
const borders = { top: border, bottom: border, left: border, right: border };

function cellPara(children: Runs): Paragraph {
  return new Paragraph({ children, spacing: { ...SPACING.tableCell } });
}

function cell(children: Paragraph, opts: { width?: number; fill?: string } = {}): TableCell {
  return new TableCell({
    borders,
    width: opts.width ? { size: opts.width, type: WidthType.DXA } : undefined,
    shading: opts.fill ? { fill: opts.fill, type: ShadingType.CLEAR } : undefined,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    verticalAlign: VerticalAlign.CENTER,
    children: [children],
  });
}

function textCell(text: string, opts: { width?: number; fill?: string; bold?: boolean } = {}): TableCell {
  return cell(cellPara([new TextRun({ text, bold: Boolean(opts.bold) })]), opts);
}

function fieldTable(fields: Array<[string, Runs | string]>): Table {
  const labelW = 2400;
  const valueW = 6960;
  return new Table({
    width: { size: labelW + valueW, type: WidthType.DXA },
    columnWidths: [labelW, valueW],
    rows: fields.map(
      ([label, value]) =>
        new TableRow({
          children: [
            textCell(label, { bold: true, width: labelW, fill: "F2F2F2" }),
            cell(cellPara(typeof value === "string" ? [new TextRun(value || "—")] : value), { width: valueW }),
          ],
        }),
    ),
  });
}

function aiScreeningRuns(row: RadarRowPayload): Runs {
  if (!row.screeningUrl) return [new TextRun("Chưa có — cần screening")];
  const link = new ExternalHyperlink({
    link: row.screeningUrl,
    children: [new TextRun({ text: "Xem chi tiết", style: "Hyperlink" })],
  });
  if (row.analysisScore == null) return [link];
  return [new TextRun(`${Math.round(row.analysisScore)} — `), link];
}

function taptapLinkRuns(appId: number): Runs {
  return [
    new ExternalHyperlink({
      link: `https://www.taptap.cn/app/${appId}`,
      children: [new TextRun({ text: `taptap.cn/app/${appId}`, style: "Hyperlink" })],
    }),
  ];
}

function videoRuns(url: string | null | undefined): Runs {
  if (!url) return [new TextRun("Chưa tìm thấy")];
  return [
    new TextRun("TapTap — "),
    new ExternalHyperlink({ link: url, children: [new TextRun({ text: url.replace(/^https?:\/\/(www\.)?/, ""), style: "Hyperlink" })] }),
  ];
}

function gameFields(row: RadarRowPayload): Table {
  return fieldTable([
    ["Game name", [rowLink(row)]],
    ["Điểm Potential", row.score.toFixed(1)],
    ["AI Screening", aiScreeningRuns(row)],
    ["Genre", row.genre || "—"],
    ["Nhà phát hành", [new TextRun({ text: row.publisher || "—", bold: true })]],
    ["Lịch phát hành", row.releaseLabel || "—"],
    ["Status", row.nextAction],
    ["Lý do", reasonDetail(row)],
    ["Video gameplay", videoRuns(row.videoUrl)],
    ["Link TapTap", taptapLinkRuns(row.appId)],
  ]);
}

function bulletRuns(b: RadarBullet): Runs {
  const runs: Runs = [];
  if (b.isNew) runs.push(new TextRun({ text: "MỚI — ", bold: true }));
  runs.push(gameLink(b.nameCn, b.nameEn, b.overviewUrl));
  runs.push(new TextRun(b.text));
  return runs;
}

function kyLabel(periodCode: string): string {
  return `${Number(periodCode.slice(2, 4))}/${Number(periodCode.slice(0, 2))}`;
}

function countTable(summary: RadarSummary): Table {
  const colW = [2200, 1160, 1160, 1160, 1160, 1160, 1160];
  const header = ["Bảng", ...COUNT_KEYS];
  const last = summary.counts.length - 1;
  return new Table({
    width: { size: colW.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    columnWidths: colW,
    rows: [
      new TableRow({ children: header.map((t, i) => textCell(t, { bold: true, width: colW[i], fill: "D9D9D9" })) }),
      ...summary.counts.map(
        (row, ri) =>
          new TableRow({
            children: [row.label, ...COUNT_KEYS.map((k) => String(row.counts[k] ?? 0))].map((t, i) =>
              textCell(t, { bold: ri === last, width: colW[i], fill: ri === last ? "EDEDED" : undefined }),
            ),
          }),
      ),
    ],
  });
}

function overviewTable(rows: RadarRowPayload[]): Table {
  const colW = [7360, 2000];
  return new Table({
    width: { size: colW[0] + colW[1], type: WidthType.DXA },
    columnWidths: colW,
    rows: [
      new TableRow({
        children: [
          textCell("Tên game", { bold: true, width: colW[0], fill: "D9D9D9" }),
          textCell("Next Action", { bold: true, width: colW[1], fill: "D9D9D9" }),
        ],
      }),
      ...rows.map(
        (row, i) =>
          new TableRow({
            children: [
              cell(cellPara([rowLink(row)]), { width: colW[0], fill: i % 2 ? "F7F7F7" : "FFFFFF" }),
              textCell(row.nextAction, { width: colW[1], fill: colorFor(row.nextAction) }),
            ],
          }),
      ),
    ],
  });
}

export async function radarDocxBuffer(summary: RadarSummary, rows: RadarRowPayload[], dateIso: string): Promise<Buffer> {
  const children: Array<Paragraph | Table> = [];
  children.push(
    new Paragraph({
      spacing: { before: 0, after: 40 },
      children: [new TextRun({ text: "GAME RADAR & TESTING RECAP", bold: true, size: 40, color: "1F4E78" })],
    }),
    new Paragraph({
      spacing: { before: 0, after: 40 },
      children: [
        new TextRun({ text: `Executive Summary — Kỳ ${kyLabel(summary.periodCode)}`, size: 26, color: "2E75B6", bold: true }),
      ],
    }),
    divider(),
  );

  children.push(h1("1. Overview"), h2("Số liệu nhanh:"));
  const testing = summary.testingThisWeek ?? [];
  if (testing.length > 0) {
    children.push(bulletP([new TextRun({ text: "Game đang test trong tuần:", bold: true })]));
    for (const line of testing) children.push(bulletP([new TextRun(line)], 1));
  }
  const now = playableNowGames(rows);
  children.push(bulletP([new TextRun({ text: "Game hiện có thể test:", bold: true })]));
  if (now.length === 0) {
    children.push(bulletP([new TextRun("Không có game nào đang mở test/đã ra mắt tại thời điểm chốt kỳ.")], 1));
  }
  for (const row of now) {
    const line = playableNowLine(row);
    const rest = line.slice(line.indexOf(" — "));
    children.push(bulletP([rowLink(row), new TextRun(rest)], 1));
  }
  children.push(
    bulletP([
      new TextRun({ text: "Game Monitor chưa có thời gian: ", bold: true }),
      new TextRun(String(summary.monitorNoDateCount)),
    ]),
  );
  children.push(p(""), p("Bảng đếm số lượng game theo Next Action:"), countTable(summary), p(""));
  const overview = overviewGames(rows);
  children.push(p("Bảng tổng quan — toàn bộ game đang ở Test Viable / Monitor trong kỳ:"));
  children.push(overview.length ? overviewTable(overview) : p("Không có game Test Viable hoặc Monitor trong kỳ này."));
  children.push(p(""), p("Định nghĩa các nhãn:"));
  for (const d of LABEL_DEFINITIONS) children.push(bulletP([new TextRun(d)]));

  children.push(h1("2. Game Overview"));
  children.push(p("Chỉ hiển thị game hiện chơi/test được hoặc đã có ngày test/ra mắt cụ thể:"));
  const renderGames = (list: RadarRowPayload[]) => {
    if (list.length === 0) children.push(p("Không có"));
    for (const row of list) children.push(h3([rowLink(row)]), gameFields(row), p(""));
  };
  children.push(h2("Game hiện có thể test:"));
  renderGames(now);
  children.push(h2("Game sắp có thể test:"));
  renderGames(upcomingGames(rows, dateIso));

  const s3 = summary.section3;
  children.push(h1("3. Executive Summary"), h2("Biến động đáng chú ý trong tuần:"), p("Mới xuất hiện:"));
  if (!s3 || s3.newEntries.length === 0) children.push(bulletP([new TextRun("Không có game mới cần Monitor trong kỳ này.")]));
  for (const b of s3?.newEntries ?? []) children.push(bulletP(bulletRuns(b)));
  children.push(p("Cập nhật lịch trình mới:"));
  if (!s3 || s3.scheduleUpdates.length === 0) children.push(bulletP([new TextRun("Không có lịch ra mắt/test mới trong kỳ này.")]));
  for (const b of s3?.scheduleUpdates ?? []) children.push(bulletP(bulletRuns(b)));

  children.push(h2("Game có thể test:"));
  if (!s3 || s3.testable.length === 0) children.push(p("Không có game nào ở mức Test Viable trong kỳ này."));
  for (const b of s3?.testable ?? []) children.push(bulletP(bulletRuns(b)));

  children.push(h2("Thông tin game thị trường mới"));
  if (!s3 || s3.market.length === 0) children.push(p("Không có game của NPH lớn trong kỳ này."));
  for (const block of s3?.market ?? []) {
    children.push(nphTitle(block.publisher));
    for (const b of block.items) children.push(bulletP(bulletRuns(b)));
  }

  const doc = new Document({
    styles: {
      default: { document: { run: { font: "Arial", size: 22 } } },
      paragraphStyles: [
        {
          id: "Heading1",
          name: "Heading 1",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { size: 32, bold: true, font: "Arial", color: "1F4E78" },
          paragraph: {
            spacing: { before: 360, after: 200 },
            outlineLevel: 0,
            border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "D9E2F3", space: 4 } },
          },
        },
        {
          id: "Heading2",
          name: "Heading 2",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { size: 26, bold: true, font: "Arial", color: "2E75B6" },
          paragraph: { spacing: { before: 280, after: 160 }, outlineLevel: 1 },
        },
        {
          id: "Heading3",
          name: "Heading 3",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { size: 24, bold: true, font: "Arial" },
          paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 2 },
        },
      ],
    },
    numbering: {
      config: [
        {
          reference: "bullets",
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "•",
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } },
            },
            {
              level: 1,
              format: LevelFormat.BULLET,
              text: "◦",
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 1080, hanging: 360 } } },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 12240, height: 15840 },
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
          },
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
}

function argb(hex: string): string {
  return `FF${hex}`;
}

function solid(hex: string): ExcelJS.Fill {
  return { type: "pattern", pattern: "solid", fgColor: { argb: argb(hex) } };
}

function trendText(trend: string | null | undefined): string {
  if (trend === "up") return "Tăng";
  if (trend === "down") return "Giảm";
  if (trend === "stable") return "Ổn định";
  return "—";
}

function screeningLabel(row: RadarRowPayload): string {
  if (row.screeningUrl) return row.analysisScore != null ? `${Math.round(row.analysisScore)} — Xem chi tiết` : "Xem chi tiết";
  return needsScreening(row.nextAction) ? "Chưa có — cần screening" : "—";
}

const HEAD_COLUMNS = [
  "Game",
  "Tên (EN)",
  "Hạng",
  "Quy mô & TT",
  "Đánh giá",
  "Chất lượng hạng",
  "Tin cậy",
  "Điểm",
  "Xu hướng",
  "Đặt trước/Tải",
  "Rating",
];

const RESERVE_TAIL = [
  "Insights",
  "Next Action",
  "Tool Adjustments",
  "AI Screening",
  "Genre",
  "Nhà phát hành",
  "Lịch phát hành",
  "Lý do",
  "Video gameplay",
  "taptap_id",
  "Overview Link",
];

const LAUNCH_TAIL = [
  "Insights",
  "Ngày ra mắt",
  "Recommend Next Action",
  "Tool Adjustments",
  "AI Screening",
  "Genre",
  "Nhà phát hành",
  "Lý do",
  "Video gameplay",
  "taptap_id",
  "Overview Link",
];

const COLUMN_WIDTH: Record<string, number> = {
  Game: 28,
  "Tên (EN)": 26,
  Insights: 60,
  "Tool Adjustments": 48,
  "Lý do": 44,
  "AI Screening": 22,
  "Next Action": 30,
  "Recommend Next Action": 30,
  Genre: 28,
  "Nhà phát hành": 24,
  "Lịch phát hành": 26,
  "Ngày ra mắt": 24,
  "Video gameplay": 30,
  "Overview Link": 14,
  "Đặt trước/Tải": 22,
};

export async function radarXlsxBuffer(periodCode: string, rows: RadarRowPayload[]): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  for (const board of RADAR_BOARDS) {
    const sheet = book.addWorksheet(`${board.sheet} (${periodCode})`.slice(0, 31));
    const launch = board.id === "new_launch";
    const columns = [...HEAD_COLUMNS, ...(launch ? LAUNCH_TAIL : RESERVE_TAIL)];
    const col = (name: string) => columns.indexOf(name) + 1;
    sheet.addRow(columns);

    const boardRows = rows.filter((r) => r.board === board.id).sort((a, b) => a.rank - b.rank);
    for (const row of boardRows) {
      const m = row.metrics;
      const values: Record<string, string | number | null> = {
        Game: row.title,
        "Tên (EN)": row.titleEn || "",
        Hạng: row.rank,
        "Quy mô & TT": m?.audienceScore ?? null,
        "Đánh giá": m?.ratingScore ?? null,
        "Chất lượng hạng": m?.rankQualityScore ?? null,
        "Tin cậy": m?.dataConfidence ?? null,
        Điểm: Math.round(row.score * 10) / 10,
        "Xu hướng": trendText(m?.trend),
        "Đặt trước/Tải": m ? scaleLabel(m) : "—",
        Rating: m?.rating ?? "",
        Insights: row.insights,
        "Next Action": row.nextAction,
        "Recommend Next Action": row.nextAction,
        "Ngày ra mắt": row.releaseLabel || "",
        "Lịch phát hành": row.releaseLabel || "",
        "Tool Adjustments": row.toolAdjustments,
        "AI Screening": screeningLabel(row),
        Genre: row.genre,
        "Nhà phát hành": row.publisher,
        "Lý do": row.reason || "",
        "Video gameplay": row.videoUrl || "Chưa tìm thấy",
        taptap_id: row.appId,
        "Overview Link": "Overview",
      };
      const added = sheet.addRow(columns.map((c) => values[c] ?? ""));

      const gameCell = added.getCell(col("Game"));
      gameCell.value = { text: row.title, hyperlink: `https://www.taptap.cn/app/${row.appId}` };
      added.getCell(col("Overview Link")).value = { text: "Overview", hyperlink: row.overviewUrl };
      if (row.videoUrl) added.getCell(col("Video gameplay")).value = { text: row.videoUrl, hyperlink: row.videoUrl };
      const screenCell = added.getCell(col("AI Screening"));
      if (row.screeningUrl) screenCell.value = { text: screeningLabel(row), hyperlink: row.screeningUrl };
      else if (needsScreening(row.nextAction)) screenCell.fill = solid(COLORS.drop);

      added.getCell(col(launch ? "Recommend Next Action" : "Next Action")).fill = solid(colorFor(row.nextAction));
      const adjCell = added.getCell(col("Tool Adjustments"));
      if (row.firstInRecap) gameCell.fill = solid(ALERT_FILL);
      if (row.firstInRecap || hasAlert(row.toolAdjustments)) adjCell.fill = solid(ALERT_FILL);
      added.alignment = { vertical: "top", wrapText: true };
    }

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
    headerRow.alignment = { vertical: "middle", wrapText: true };
    headerRow.eachCell((c) => {
      c.fill = solid("1F4E79");
    });
    columns.forEach((name, i) => {
      sheet.getColumn(i + 1).width = COLUMN_WIDTH[name] ?? 12;
    });
    sheet.views = [{ state: "frozen", xSplit: 1, ySplit: 1 }];
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}
