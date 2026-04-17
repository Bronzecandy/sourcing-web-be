import type { StratifiedReview } from "../services/ai-analysis.service";

const RATING_BUCKET_MAP: Record<number, string> = {
  1: "Very Negative",
  2: "Negative",
  3: "Mixed",
  4: "Positive",
  5: "Very Positive",
};

interface ParsedCsvResult {
  reviews: StratifiedReview[];
  gameName: string;
  appId: string;
}

function detectDelimiter(firstLine: string): string {
  const tabCount = (firstLine.match(/\t/g) ?? []).length;
  const commaCount = (firstLine.match(/,/g) ?? []).length;
  return tabCount >= commaCount ? "\t" : ",";
}

function splitRow(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findColumn(headers: string[], ...candidates: string[]): number {
  const normalized = headers.map(normalizeHeader);
  for (const c of candidates) {
    const idx = normalized.indexOf(normalizeHeader(c));
    if (idx >= 0) return idx;
  }
  return -1;
}

function decodeBuffer(buffer: Buffer): string {
  // UTF-16 LE BOM: FF FE
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString("utf16le").slice(1); // decode and strip BOM
  }
  // UTF-16 BE BOM: FE FF — swap bytes to LE then decode
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.alloc(buffer.length);
    for (let i = 0; i < buffer.length - 1; i += 2) {
      swapped[i] = buffer[i + 1];
      swapped[i + 1] = buffer[i];
    }
    return swapped.toString("utf16le").slice(1);
  }
  // No BOM but contains lots of \x00 → likely UTF-16 LE without BOM
  const nullCount = buffer.slice(0, Math.min(200, buffer.length)).filter((b) => b === 0).length;
  if (nullCount > 20) {
    return buffer.toString("utf16le");
  }
  // UTF-8 (strip BOM if present)
  let text = buffer.toString("utf-8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

function stripNullBytes(s: string): string {
  return s.replace(/\0/g, "");
}

export function parseCsvBuffer(buffer: Buffer): ParsedCsvResult {
  let text = decodeBuffer(buffer);
  text = stripNullBytes(text);

  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    throw new Error("CSV file must have at least a header row and one data row");
  }

  const delimiter = detectDelimiter(lines[0]);
  const headers = splitRow(lines[0], delimiter);

  const contentIdx = findColumn(headers, "Content", "content", "Review", "review", "Text", "text");
  const ratingIdx = findColumn(headers, "Rating", "rating", "Score", "score", "Stars", "stars");
  const dateIdx = findColumn(headers, "Date", "date", "ReviewDate", "reviewdate");
  const appNameIdx = findColumn(headers, "App Name", "appname", "Unified Name", "unifiedname", "Game", "game");
  const appIdIdx = findColumn(headers, "App ID", "appid", "Unified ID", "unifiedid");

  if (contentIdx < 0) {
    throw new Error(
      `Cannot find review text column. Expected one of: Content, Review, Text. Found headers: ${headers.join(", ")}`
    );
  }

  let gameName = "Unknown Game";
  let appId = "csv-upload";

  const reviews: StratifiedReview[] = [];

  for (let i = 1; i < lines.length; i++) {
    const fields = splitRow(lines[i], delimiter);

    if (i === 1) {
      if (appNameIdx >= 0 && fields[appNameIdx]?.trim()) {
        gameName = fields[appNameIdx].trim();
      }
      if (appIdIdx >= 0 && fields[appIdIdx]?.trim()) {
        appId = fields[appIdIdx].trim();
      }
    }

    const content = fields[contentIdx]?.trim() ?? "";
    if (content.length < 5) continue;

    const rawRating = ratingIdx >= 0 ? Number(fields[ratingIdx]?.trim()) : 0;
    const score = Number.isFinite(rawRating) ? Math.round(Math.max(1, Math.min(5, rawRating))) : 0;

    const rawDate = dateIdx >= 0 ? fields[dateIdx]?.trim() ?? "unknown" : "unknown";
    const date = /^\d{4}-\d{2}-\d{2}/.test(rawDate) ? rawDate.slice(0, 10) : rawDate;

    const bucket = RATING_BUCKET_MAP[score] ?? "Unrated";

    reviews.push({ text: content, score, date, bucket });
  }

  if (reviews.length === 0) {
    throw new Error("No valid reviews found in the uploaded file (all reviews were too short or missing)");
  }

  console.log(
    `[csv-parser] Parsed ${reviews.length} reviews for "${gameName}" (appId=${appId}) from ${lines.length - 1} rows`
  );

  return { reviews, gameName, appId };
}
