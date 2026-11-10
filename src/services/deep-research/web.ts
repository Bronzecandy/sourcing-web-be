import { callLLM } from "../../utils/ai-client";
import { compassWebSearch } from "../../utils/compass-web-search";
import type { TapTapFacts } from "./taptap";
import type { FindingCategory, GameIdentity, WebFinding, WebReport } from "./types";

const CN_HINT = "Market: China and global. Prefer official sites, TapTap, App Store, Google Play, Steam, Wikipedia, company investor-relations pages, and gaming press in English or Chinese.";

function parseJson(content: string): Record<string, unknown> | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(content.slice(start, end + 1)) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean) : []);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function developerLine(facts: TapTapFacts): string {
  return facts.developers.map((d) => `${d.name}${d.type ? ` (${d.type})` : ""}`).join(", ") || "unknown";
}

const IDENTITY_SYSTEM = `You turn a web-search brief about one game into JSON. Return one JSON object only, no markdown:
{"internationalNames":["..."],"otherNames":["..."],"developerEn":"...","publisherEn":"...","steamUrl":"https://store.steampowered.com/app/...","released":"cn|global|both|unreleased|unknown","note":"..."}
Rules:
- Every name must appear verbatim in the brief. Do not translate, romanise, or invent names.
- internationalNames: official English/global titles of this exact game. otherNames: other regional titles (Japanese, Korean, Traditional Chinese). Do not repeat the Chinese title the user gave.
- developerEn / publisherEn: English company names from the brief, or null.
- steamUrl: copy exactly from the allowed URL list when the game has a Steam page, else null.
- released: where the game is released today according to the brief.
- note: one Vietnamese sentence on release status and any ambiguity (e.g. a different game with a similar name). null if nothing to add.`;

export async function researchIdentity(facts: TapTapFacts): Promise<GameIdentity> {
  const at = new Date().toISOString();
  const empty: GameIdentity = { internationalNames: [], otherNames: [], developerEn: null, publisherEn: null, steamAppId: null, released: "unknown", note: null, grounded: false, queries: [], sources: [], at };
  const question = `Identify the mobile game listed on TapTap China as 《${facts.title}》 (TapTap app id ${facts.appId}; developer/publisher on TapTap: ${developerLine(facts)}${facts.releaseDate ? `; TapTap release date ${facts.releaseDate}` : ""}).
Find: its official English / international title and other regional titles (Japanese, Korean, Traditional Chinese); the developer and publisher names in English; whether it is released in China, globally, or not yet; and whether it has a Steam (PC) store page — give the Steam store URL if it exists.`;
  const search = await compassWebSearch(question, { sourceHint: CN_HINT, maxOutputTokens: 3072 });
  if (!search.grounded || !search.brief) return { ...empty, queries: search.queries, sources: search.sources };

  const response = await callLLM(IDENTITY_SYSTEM, ["Allowed URLs:", ...search.sources, "", `Chinese title given by the user: ${facts.title}`, "", "Brief:", search.brief].join("\n"), 1500);
  const json = parseJson(response.content) ?? {};
  const brief = search.brief.toLowerCase();
  const inBrief = (n: string) => n.length >= 2 && brief.includes(n.toLowerCase()) && n !== facts.title;
  const steamUrl = text(json.steamUrl);
  const steamMatch = steamUrl && search.sources.some((s) => s.split("?")[0] === steamUrl.split("?")[0]) ? /store\.steampowered\.com\/app\/(\d+)/.exec(steamUrl) : null;
  const released = text(json.released);
  return {
    internationalNames: [...new Set(strings(json.internationalNames).filter(inBrief))].slice(0, 4),
    otherNames: [...new Set(strings(json.otherNames).filter(inBrief))].slice(0, 4),
    developerEn: text(json.developerEn) && inBrief(text(json.developerEn)!) ? text(json.developerEn) : null,
    publisherEn: text(json.publisherEn) && inBrief(text(json.publisherEn)!) ? text(json.publisherEn) : null,
    steamAppId: steamMatch ? Number(steamMatch[1]) : null,
    released: released && ["cn", "global", "both", "unreleased"].includes(released) ? (released as GameIdentity["released"]) : "unknown",
    note: text(json.note),
    grounded: true,
    queries: search.queries,
    sources: search.sources,
    at,
  };
}

const CATEGORIES: FindingCategory[] = ["performance", "launch", "reception", "company_financial", "company_news", "risk"];

const FINDINGS_SYSTEM = `You turn a web-search brief into JSON. Return one JSON object only, no markdown:
{"findings":[{"category":"performance|launch|reception|company_financial|company_news|risk","claim":"...","date":"YYYY-MM-DD","url":"https://...","sentiment":"positive|neutral|negative"}]}
Rules:
- claim is one sentence written in Vietnamese restating a claim already in the brief, keeping its numbers, currency and period. Translate Chinese or English source wording into Vietnamese; keep only proper names (game titles, companies, 版号) in their original script. Do not add facts or opinions.
- date is the publication date of that claim copied from the brief (YYYY-MM-DD). Omit the finding when the brief gives no date.
- url is copied exactly from the allowed URL list. Omit the finding when its URL is not in that list.
- performance = revenue, downloads, rankings, player counts; launch = test/launch dates, licence (版号), regions; reception = player/critic reception; company_financial = earnings, revenue, profit, guidance; company_news = pipeline, M&A, funding, layoffs, leadership; risk = regulation, controversy, shutdowns.
- sentiment is for the game/company's commercial outlook.
- At most 12 findings, most recent and most material first. If nothing qualifies, return {"findings":[]}.`;

async function structureFindings(brief: string, sources: string[], subject: "game" | "company", offset: number): Promise<WebFinding[]> {
  const allowed = new Set(sources);
  const response = await callLLM(
    FINDINGS_SYSTEM,
    ["Allowed URLs (copy exactly, or omit the finding):", ...sources, "", "Brief:", brief, "", "Write every claim in Vietnamese."].join("\n"),
    3500,
  );
  const items = (parseJson(response.content)?.findings as unknown[]) ?? [];
  const out: WebFinding[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object") continue;
    const f = item as Record<string, unknown>;
    const category = text(f.category) as FindingCategory | null;
    const claim = text(f.claim);
    const date = text(f.date);
    const url = text(f.url);
    const sentiment = text(f.sentiment);
    if (!category || !CATEGORIES.includes(category) || !claim || !url || !allowed.has(url)) continue;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !brief.includes(date)) continue;
    const key = `${url}\n${claim.slice(0, 60)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: `F${offset + out.length + 1}`,
      subject,
      category,
      claim: claim.slice(0, 400),
      date,
      url,
      sentiment: sentiment === "positive" || sentiment === "negative" ? sentiment : "neutral",
    });
  }
  return out.slice(0, 12);
}

export interface ResearchNames {
  title: string;
  international: string | null;
  developer: string | null;
  publisher: string | null;
}

export async function researchWeb(names: ResearchNames): Promise<WebReport> {
  const game = names.international ? `"${names.international}" (Chinese title 《${names.title}》)` : `《${names.title}》`;
  const company = [names.developer, names.publisher].filter((v, i, a): v is string => Boolean(v) && a.indexOf(v) === i).join(" / ") || null;
  const gameQ = `Research the commercial performance of the game ${game}${company ? ` by ${company}` : ""}.
Find from the last 24 months: revenue and download estimates or rankings (Sensor Tower, AppMagic, Game Data/游戏工委, App Store/TapTap charts), player counts or pre-registrations, test and launch history, licence approval (版号), regions launched, notable updates, player and critic reception, and any controversies or shutdown news.`;
  const companyQ = company
    ? `Research the developer/publisher ${company} of the game ${game}.
Find the latest financial reports (annual/interim/quarterly results: revenue, profit, game segment), stock exchange filings or investor presentations, their major titles and how those perform, upcoming pipeline, and news on funding, M&A, layoffs or leadership in the last 24 months.`
    : null;

  const errors: string[] = [];
  const run = async (q: string, subject: "game" | "company", offset: number) => {
    try {
      const search = await compassWebSearch(q, { sourceHint: CN_HINT, maxOutputTokens: 6000 });
      if (!search.grounded || !search.brief || !search.sources.length) return { queries: search.queries, grounded: search.grounded, findings: [] as WebFinding[] };
      return { queries: search.queries, grounded: true, findings: await structureFindings(search.brief, search.sources, subject, offset) };
    } catch (err) {
      errors.push(`${subject}: ${(err as Error).message.slice(0, 200)}`);
      return { queries: [] as string[], grounded: false, findings: [] as WebFinding[] };
    }
  };
  const [g, c] = await Promise.all([run(gameQ, "game", 0), companyQ ? run(companyQ, "company", 100) : Promise.resolve(null)]);
  const findings = [...g.findings, ...(c?.findings ?? [])].map((f, i) => ({ ...f, id: `F${i + 1}` }));
  return { grounded: g.grounded || Boolean(c?.grounded), queries: [...g.queries, ...(c?.queries ?? [])], findings, errors };
}
