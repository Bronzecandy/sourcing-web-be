import {
  Document,
  ExternalHyperlink,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import ExcelJS from "exceljs";
import { COUNT_KEYS } from "./radar-copy";
import { RADAR_BOARDS, actionFamily, type RadarRowPayload, type RadarSummary } from "./radar-types";

function fillFor(action: string): string {
  const family = actionFamily(action);
  if (family === "viable") return "FF9DC3E6";
  if (family === "high") return "FFA9D18E";
  if (family === "mid") return "FFC6E0B4";
  if (family === "low") return "FFFFE699";
  if (family === "ignore") return "FFFFD9A0";
  return "FFFFC7CE";
}

function p(text: string, opts?: { bold?: boolean; heading?: (typeof HeadingLevel)[keyof typeof HeadingLevel] }): Paragraph {
  return new Paragraph({
    heading: opts?.heading,
    children: [new TextRun({ text, bold: opts?.bold })],
  });
}

function linkParagraph(label: string, url: string): Paragraph {
  return new Paragraph({
    children: [
      new ExternalHyperlink({
        link: url,
        children: [new TextRun({ text: label, style: "Hyperlink" })],
      }),
    ],
  });
}

export async function radarDocxBuffer(summary: RadarSummary, rows: RadarRowPayload[]): Promise<Buffer> {
  const children: Array<Paragraph | Table> = [
    p("GAME RADAR & TESTING RECAP", { heading: HeadingLevel.TITLE }),
    p(summary.dateLabel),
    p("1. Overview", { heading: HeadingLevel.HEADING_1 }),
    p("Số liệu nhanh:", { bold: true }),
    p("Game hiện có thể test:", { bold: true }),
  ];
  if (summary.testableNow.length === 0) children.push(p("Không có"));
  for (const block of summary.testableNow) {
    const [line, url] = block.split("\n");
    children.push(p(`• ${line ?? block}`));
    if (url) children.push(linkParagraph(url, url));
  }
  children.push(p(`Game Monitor chưa có thời gian ra mắt: ${summary.monitorNoDateCount}`));
  children.push(p("Bảng đếm số lượng game theo Next Action:", { bold: true }));

  const header = new TableRow({
    children: ["Bảng", ...COUNT_KEYS].map(
      (text) =>
        new TableCell({
          width: { size: 1200, type: WidthType.DXA },
          children: [p(text, { bold: true })],
        }),
    ),
  });
  const body = summary.counts.map(
    (row) =>
      new TableRow({
        children: [row.label, ...COUNT_KEYS.map((k) => String(row.counts[k] ?? 0))].map(
          (text) => new TableCell({ children: [p(text)] }),
        ),
      }),
  );
  children.push(new Table({ rows: [header, ...body], width: { size: 100, type: WidthType.PERCENTAGE } }));

  children.push(p("2. Game Overview", { heading: HeadingLevel.HEADING_1 }));
  children.push(p("Game hiện có thể test:", { bold: true }));
  const seen = new Set<number>();
  for (const row of rows) {
    if (!row.playableNow || seen.has(row.appId)) continue;
    seen.add(row.appId);
    const name = row.titleEn ? `${row.title} (${row.titleEn})` : row.title;
    children.push(linkParagraph(`${name} — ${row.nextAction}`, row.overviewUrl));
    children.push(p(row.insights));
    if (row.releaseLabel) children.push(p(row.releaseLabel));
  }
  if (seen.size === 0) children.push(p("Không có"));

  children.push(p("Sắp có thể test:", { bold: true }));
  if (summary.upcoming.length === 0) children.push(p("Không có"));
  for (const block of summary.upcoming) {
    const [line, url] = block.split("\n");
    children.push(p(line ?? block));
    if (url) children.push(linkParagraph(url, url));
  }

  children.push(p("3. Executive Summary", { heading: HeadingLevel.HEADING_1 }));
  for (const para of summary.executiveParagraphs) children.push(p(para));

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

export async function radarXlsxBuffer(periodCode: string, rows: RadarRowPayload[]): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  for (const board of RADAR_BOARDS) {
    const sheet = book.addWorksheet(`${board.sheet} (${periodCode})`.slice(0, 31));
    sheet.addRow([
      "Game",
      "Tên (EN)",
      "Hạng",
      "Điểm",
      "Insights",
      "Next Action",
      "Tool Adjustments",
      "AI Screening",
      "Genre",
      "Nhà phát hành",
      "Lịch",
      "taptap_id",
      "Overview Link",
    ]);
    const boardRows = rows.filter((r) => r.board === board.id).sort((a, b) => a.rank - b.rank);
    for (const row of boardRows) {
      const added = sheet.addRow([
        row.title,
        row.titleEn,
        row.rank,
        row.score,
        row.insights,
        row.nextAction,
        row.toolAdjustments,
        screeningLabel(row),
        row.genre,
        row.publisher,
        row.releaseLabel,
        row.appId,
        row.overviewUrl,
      ]);
      const gameCell = added.getCell(1);
      gameCell.value = { text: row.title, hyperlink: row.taptapUrl };
      const screenCell = added.getCell(8);
      if (row.screeningUrl) {
        screenCell.value = { text: screeningLabel(row), hyperlink: row.screeningUrl };
      } else {
        screenCell.value = screeningLabel(row);
      }
      const linkCell = added.getCell(13);
      linkCell.value = { text: "Overview", hyperlink: row.overviewUrl };
      added.getCell(6).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: fillFor(row.nextAction) },
      };
      if (row.firstInRecap) {
        gameCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } };
        added.getCell(7).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } };
      }
      if (!row.screeningUrl && (row.nextAction.startsWith("Monitor") || row.nextAction.startsWith("Test Viable"))) {
        screenCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFC7CE" } };
      }
    }
    sheet.getRow(1).font = { bold: true };
    sheet.columns.forEach((col) => {
      col.width = 22;
    });
  }
  const out = await book.xlsx.writeBuffer();
  return Buffer.from(out);
}

function screeningLabel(row: RadarRowPayload): string {
  if (row.screeningUrl && row.analysisScore != null) return `${row.analysisScore} — Xem chi tiết`;
  if (row.screeningUrl) return "Xem chi tiết";
  if (row.nextAction === "Drop" || row.nextAction === "Temporary Ignore") return "—";
  return "Chưa có — cần screening";
}
