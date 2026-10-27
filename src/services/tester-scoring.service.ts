import crypto from "crypto";
import { jsonrepair } from "jsonrepair";
import { prismaApp } from "../utils/prisma-app";
import { callLLM, getModel } from "../utils/ai-client";
import { logDiagError } from "../utils/process-diagnostics";
import { testerConfig } from "./tester-config";
import { genreAnswers, getActiveSurvey, type SurveyAnswers } from "./tester-survey.service";

export interface GenreScoreResult {
  volumeScore: number;
  rankScore: number;
  hasRank: boolean;
  hours: number;
  matches: number;
  anchorGame: string;
  bestRank: string;
  matchedGames: string[];
  finalScore: number;
}

interface LibraryMeta {
  canonicalName: string;
  aliases: string[];
  genres: string[];
  subgenres: string[];
  source: string;
  confidence: number;
}

function normalizeGenre(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "").replace(/[_-]+/g, "");
}

function normalizeText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s:.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clampInt(v: unknown, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function parseJson(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced?.[1] ?? text).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  const slice = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
  try {
    return JSON.parse(slice) as Record<string, unknown>;
  } catch {
    return JSON.parse(jsonrepair(slice)) as Record<string, unknown>;
  }
}

async function llmJson(prompt: string, temperature: number): Promise<Record<string, unknown>> {
  const res = await callLLM("Return only valid JSON. No markdown. No explanation.", prompt, 400, { temperature });
  return parseJson(res.content);
}

/** Bucket volume theo bảng Experience Library (hours/matches → 0..50). */
export function bucketScore(value: number, thresholds: Array<[number, number]>): number {
  if (!value || value <= 0) return 0;
  for (const [limit, score] of thresholds) if (value <= limit) return score;
  return 50;
}

export function finalScore(volume: number, rank: number, hasRank: boolean): number {
  return Math.max(0, Math.min(100, Math.round(hasRank ? volume + rank : volume * 2)));
}

function genreHints(genre: string): string[] {
  const g = testerConfig.genres().find((x) => normalizeGenre(x.key) === normalizeGenre(genre));
  return g?.hints ?? [genre];
}

/** Seed Game Library từ data/tester/game-library.json khi bảng còn trống. */
export async function ensureGameLibrarySeeded(): Promise<number> {
  const count = await prismaApp.gameLibraryEntry.count();
  if (count > 0) return 0;
  const seed = testerConfig.library();
  for (const entry of seed) {
    await prismaApp.gameLibraryEntry.upsert({
      where: { canonicalName: entry.canonicalName },
      create: { ...entry, notes: entry.notes || null },
      update: {},
    });
  }
  return seed.length;
}

function splitCandidates(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const chunk of raw.split(/;|\n|\|/)) {
    const cleaned = chunk.trim().replace(/^[-*•\s]+/, "").trim();
    const left = cleaned.split(/\s+-\s+/)[0]?.trim() ?? "";
    const key = left.toLowerCase();
    if (left && !seen.has(key)) {
      seen.add(key);
      out.push(left);
    }
  }
  return out;
}

function resolveInLibrary(name: string, genre: string, library: LibraryMeta[]): LibraryMeta | null {
  const query = normalizeText(name);
  const g = normalizeGenre(genre);
  if (!query) return null;
  for (const entry of library) {
    const canonical = normalizeText(entry.canonicalName);
    const aliases = entry.aliases.map(normalizeText);
    const nameMatched =
      query === canonical ||
      aliases.includes(query) ||
      canonical.includes(query) ||
      query.includes(canonical) ||
      aliases.some((a) => a && (a.includes(query) || query.includes(a)));
    if (nameMatched && entry.genres.map(normalizeGenre).includes(g)) return entry;
  }
  return null;
}

async function aiClassify(name: string, genre: string): Promise<LibraryMeta | null> {
  const prompt =
    "Hãy phân loại game sau thành metadata tối thiểu.\n\n" +
    `Game: [${name}]\n` +
    `Target genre cần kiểm tra: [${genre}]\n\n` +
    "NHIỆM VỤ:\n" +
    "1) Nếu game có khả năng hợp lý thuộc target genre thì trả metadata phù hợp.\n" +
    "2) Nếu không chắc, confidence phải thấp.\n" +
    "3) Chỉ trả JSON.\n\n" +
    'Trả về JSON duy nhất: {"canonical_name":"string","aliases":["string"],"genres":["string"],"subgenres":["string"],"confidence":integer,"notes":"string"}';
  try {
    const data = await llmJson(prompt, 0.1);
    const canonical = typeof data.canonical_name === "string" ? data.canonical_name.trim() : "";
    if (!canonical) return null;
    const genres = Array.isArray(data.genres) ? data.genres.map(String) : [genre];
    const confidence = clampInt(data.confidence, 0, 100);
    if (!genres.map(normalizeGenre).includes(normalizeGenre(genre)) && confidence < 70) return null;
    return {
      canonicalName: canonical,
      aliases: Array.isArray(data.aliases) ? data.aliases.map(String) : [name],
      genres,
      subgenres: Array.isArray(data.subgenres) ? data.subgenres.map(String) : [],
      source: "ai_classified",
      confidence,
    };
  } catch {
    return null;
  }
}

async function resolveOrEnrich(raw: string, genre: string, library: LibraryMeta[]): Promise<LibraryMeta[]> {
  const resolved: LibraryMeta[] = [];
  const seen = new Set<string>();
  for (const candidate of splitCandidates(raw)) {
    let meta = resolveInLibrary(candidate, genre, library);
    if (!meta) {
      meta = await aiClassify(candidate, genre);
      if (meta) {
        const known = library.find((l) => l.canonicalName.toLowerCase() === meta!.canonicalName.toLowerCase());
        if (!known) {
          library.push(meta);
          await prismaApp.gameLibraryEntry
            .upsert({
              where: { canonicalName: meta.canonicalName },
              create: { ...meta, notes: "AI classified" },
              update: {
                aliases: [...new Set([...meta.aliases, candidate])],
                genres: meta.genres,
                subgenres: meta.subgenres,
                confidence: meta.confidence,
              },
            })
            .catch(() => undefined);
        }
      }
    }
    if (meta && !seen.has(meta.canonicalName)) {
      seen.add(meta.canonicalName);
      resolved.push(meta);
    }
  }
  return resolved;
}

function libraryContext(metas: LibraryMeta[]): string {
  if (metas.length === 0) return "Không resolve được game nào từ library.";
  return metas
    .map(
      (m) =>
        `- ${m.canonicalName} | aliases: ${m.aliases.join(", ")} | genres: ${m.genres.join(", ")} | subgenres: ${m.subgenres.join(", ")} | source: ${m.source} | confidence: ${m.confidence}`,
    )
    .join("\n");
}

function proficiencyContext(): string {
  const { levels, games } = testerConfig.scoring().rank;
  const head = levels.map((l) => `${l.score} = ${l.label}`).join(" | ");
  const rows = games.map((g) => `- ${g.game}: ${g.tiers.map((t, i) => `${levels[i]?.score}: ${t}`).join("; ")}`);
  return `Mốc điểm: ${head}\n${rows.join("\n")}`;
}

async function volumePart(raw: string, genre: string, context: string): Promise<Pick<GenreScoreResult, "volumeScore" | "hours" | "matches" | "anchorGame" | "matchedGames">> {
  const prompt =
    "Bạn cần TRÍCH XUẤT volume chơi game của game thủ theo thể loại game.\n\n" +
    `THỂ LOẠI ĐÍCH: [${genre}]\n` +
    `GAME LIBRARY CONTEXT:\n${context}\n\n` +
    `CÁC GAME / ALIAS THAM KHẢO: [${genreHints(genre).join(", ")}]\n` +
    `DỮ LIỆU NGƯỜI CHƠI: [${raw}]\n\n` +
    "NHIỆM VỤ:\n" +
    "1) Chỉ xác định những game có khả năng thuộc thể loại đích.\n" +
    "2) Nếu một game xuất hiện trong GAME LIBRARY CONTEXT và có genre phù hợp, hãy coi đó là match hợp lệ.\n" +
    "3) Không được bỏ qua các game đã được resolve trong context.\n" +
    "4) KHÔNG chấm điểm.\n" +
    "5) Chỉ trích xuất volume lớn nhất của game phù hợp nhất.\n" +
    "6) Chỉ dùng số giờ chơi và số trận chơi.\n" +
    "7) KHÔNG dùng rank để suy ra volume.\n" +
    "8) Chọn 1 game làm trục (anchor): game có volume cao nhất trong đúng thể loại.\n" +
    "9) Nếu người chơi trả lời chung chung mà không có số cụ thể, ước lượng số giờ chơi: Ít - 50 giờ, Khá ít - 100 giờ, Trung bình - 200 giờ, Nhiều - 500 giờ, Rất nhiều - 1000 giờ.\n\n" +
    "QUY TẮC:\n" +
    "- Nếu có số trận, điền vào matches.\n" +
    "- Nếu có số giờ, điền vào hours.\n" +
    `- Nếu câu trả lời là không có, không nhớ, hoặc không trích xuất được dữ liệu cụ thể (vui vẻ, giải trí, sơ sơ,...), dùng mốc thấp - ${testerConfig.scoring().volume.vagueHours} giờ.\n` +
    "- Không tự bịa volume nếu dữ liệu không nhắc đến.\n" +
    "- Ví dụ 'TFT - 100 trận - bạc' => matches = 100, hours = 0\n" +
    "- Ví dụ 'TFT - chơi game vui vẻ' => matches = 50, hours = 0\n" +
    "- Ví dụ 'Gold and Glory - 1200h - top guild' => hours = 1200, matches = 0\n\n" +
    'Trả về JSON duy nhất: {"matched_games": [string], "anchor_game": string, "hours": integer, "matches": integer}';
  const data = await llmJson(prompt, 0.1);
  const hours = clampInt(data.hours, 0, 1_000_000);
  const matches = clampInt(data.matches, 0, 1_000_000);
  const { volume } = testerConfig.scoring();
  return {
    volumeScore: Math.max(bucketScore(hours, volume.hours), bucketScore(matches, volume.matches)),
    hours,
    matches,
    anchorGame: typeof data.anchor_game === "string" ? data.anchor_game : "",
    matchedGames: Array.isArray(data.matched_games) ? data.matched_games.map(String) : [],
  };
}

async function rankPart(raw: string, genre: string, context: string): Promise<Pick<GenreScoreResult, "rankScore" | "hasRank" | "bestRank" | "matchedGames">> {
  const prompt =
    "Bạn cần đánh giá TRÌNH ĐỘ (rank/skill) của game thủ theo thể loại game.\n\n" +
    `THỂ LOẠI ĐÍCH: [${genre}]\n` +
    `GAME LIBRARY CONTEXT:\n${context}\n\n` +
    `CÁC GAME / ALIAS THAM KHẢO: [${genreHints(genre).join(", ")}]\n` +
    `DỮ LIỆU NGƯỜI CHƠI: [${raw}]\n\n` +
    "NHIỆM VỤ:\n" +
    "1) Chỉ xác định những game có khả năng thuộc thể loại đích.\n" +
    "2) Danh sách tham khảo chỉ là hint, KHÔNG phải điều kiện bắt buộc.\n" +
    "3) Vẫn chấp nhận game không có trong hint nếu theo hiểu biết phổ biến nó thuộc genre này.\n" +
    "4) Nếu một game xuất hiện trong GAME LIBRARY CONTEXT và có genre phù hợp, hãy coi đó là match hợp lệ.\n" +
    "5) Không được bỏ qua các game đã được resolve trong context.\n" +
    "6) Chỉ chấm theo RANK / SKILL, KHÔNG dùng số giờ hay số trận để chấm phần này.\n" +
    "7) Chọn rank mạnh nhất trong các game đã match.\n" +
    "8) Nếu không có rank rõ ràng thì has_rank = 0 và score = 0.\n" +
    "9) 'Không nhớ', 'rank mơ hồ', 'không có dữ liệu' => coi là không có rank rõ ràng.\n\n" +
    "THANG ĐIỂM RANK 0-50:\n" +
    "- Không có rank rõ: 0\n" +
    "- Rank thấp (dưới top 60%): 10-18\n" +
    "- Rank trung bình (top 60-40%): 18-28\n" +
    "- Rank khá (top 20%): 28-36\n" +
    "- Rank cao (top 5%): 36-44\n" +
    "- Rank top (top 1%): 44-50\n\n" +
    `BẢNG THAM CHIẾU RANK THEO GAME (Proficiency Library):\n${proficiencyContext()}\n\n` +
    "QUY TẮC QUAN TRỌNG:\n" +
    "- Chỉ xét rank trong đúng thể loại đích.\n" +
    "- KHÔNG cộng điểm vì chơi nhiều.\n" +
    "- Chỉ dùng rank rõ ràng.\n" +
    "- Nếu người chơi trả lời không rõ ràng (vd không nhớ), hãy cho là 0.\n\n" +
    'Trả về JSON duy nhất: {"score": integer, "has_rank": integer, "matched_games": [string], "best_rank": string}';
  const data = await llmJson(prompt, 0.2);
  const hasRank = Number(data.has_rank ?? 0) === 1;
  return {
    rankScore: hasRank ? clampInt(data.score, 0, 50) : 0,
    hasRank,
    bestRank: typeof data.best_rank === "string" ? data.best_rank : "",
    matchedGames: Array.isArray(data.matched_games) ? data.matched_games.map(String) : [],
  };
}

export function rawHash(genre: string, raw: string): string {
  return crypto.createHash("sha1").update(`${normalizeGenre(genre)}|${raw.trim()}`).digest("hex");
}

/** Điểm hardcore 0–100 cho 1 dòng game (cache theo hash genre|raw). */
export async function scoreGenre(genre: string, raw: string, library?: LibraryMeta[]): Promise<GenreScoreResult> {
  const key = rawHash(genre, raw);
  const cached = await prismaApp.testerScoreCache.findUnique({ where: { key } });
  if (cached) return cached.result as unknown as GenreScoreResult;

  const lib = library ?? ((await prismaApp.gameLibraryEntry.findMany()) as LibraryMeta[]);
  const context = libraryContext(await resolveOrEnrich(raw, genre, lib));
  const volume = await volumePart(raw, genre, context);
  const rank = await rankPart(raw, genre, context);
  const result: GenreScoreResult = {
    volumeScore: volume.volumeScore,
    rankScore: rank.rankScore,
    hasRank: rank.hasRank,
    hours: volume.hours,
    matches: volume.matches,
    anchorGame: volume.anchorGame,
    bestRank: rank.bestRank,
    matchedGames: [...new Set([...volume.matchedGames, ...rank.matchedGames])],
    finalScore: finalScore(volume.volumeScore, rank.rankScore, rank.hasRank),
  };
  await prismaApp.testerScoreCache
    .upsert({ where: { key }, create: { key, result: result as object }, update: { result: result as object } })
    .catch(() => undefined);
  return result;
}

/** Chấm lại toàn bộ dòng game của 1 tester từ câu trả lời mới nhất. */
export async function scoreTester(userId: string, opts: { force?: boolean } = {}): Promise<number> {
  const response = await prismaApp.surveyResponse.findFirst({
    where: { userId },
    orderBy: { submittedAt: "desc" },
  });
  if (!response) return 0;
  await ensureGameLibrarySeeded();
  const form = await getActiveSurvey();
  const answers = response.answers as SurveyAnswers;
  const items = genreAnswers(form, answers);
  const existing = await prismaApp.testerGenreScore.findMany({ where: { userId } });
  const byGenre = new Map(existing.map((e) => [e.genre, e]));
  const library = (await prismaApp.gameLibraryEntry.findMany()) as LibraryMeta[];
  const model = getModel();
  let scored = 0;

  for (const { genre, raw } of items) {
    const hash = rawHash(genre, raw);
    const prev = byGenre.get(genre);
    if (prev && prev.rawHash === hash && !opts.force) continue;
    if (opts.force) await prismaApp.testerScoreCache.delete({ where: { key: hash } }).catch(() => undefined);
    const r = await scoreGenre(genre, raw, library);
    const data = {
      rawText: raw,
      rawHash: hash,
      volumeScore: r.volumeScore,
      rankScore: r.rankScore,
      hasRank: r.hasRank,
      hours: r.hours,
      matches: r.matches,
      anchorGame: r.anchorGame || null,
      bestRank: r.bestRank || null,
      matchedGames: r.matchedGames,
      finalScore: r.finalScore,
      source: "ai",
      model,
      scoredAt: new Date(),
    };
    await prismaApp.testerGenreScore.upsert({
      where: { userId_genre: { userId, genre } },
      create: { userId, genre, ...data },
      update: data,
    });
    scored += 1;
  }

  const answered = new Set(items.map((i) => i.genre));
  const stale = existing.filter((e) => !answered.has(e.genre)).map((e) => e.genre);
  if (stale.length > 0) await prismaApp.testerGenreScore.deleteMany({ where: { userId, genre: { in: stale } } });
  return scored;
}

let queue: Promise<void> = Promise.resolve();

/** Chấm nền tuần tự (tránh dồn nhiều lượt gọi LLM cùng lúc). */
export function queueTesterScoring(userId: string, opts: { force?: boolean } = {}): void {
  queue = queue.then(async () => {
    try {
      await prismaApp.testerProfile.update({ where: { userId }, data: { scoringStatus: "scoring" } });
      await scoreTester(userId, opts);
      await prismaApp.testerProfile.update({
        where: { userId },
        data: { scoringStatus: "scored", scoredAt: new Date() },
      });
    } catch (err) {
      logDiagError("tester-scoring", err, { userId });
      await prismaApp.testerProfile
        .update({ where: { userId }, data: { scoringStatus: "failed" } })
        .catch(() => undefined);
    }
  });
}
