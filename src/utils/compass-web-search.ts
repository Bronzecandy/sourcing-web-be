/**
 * Compass Responses API + web_search.
 * A result is grounded only when the response contains a search item
 * with status "completed" and a non-empty action.queries list.
 * URLs are taken only from those items' action.sources.
 */

const DEFAULT_RESPONSES_URL = "https://compass.llm.shopee.io/compass-api/v1/responses";

export interface CompassWebSearchResult {
  grounded: boolean;
  queries: string[];
  sources: string[];
  brief: string;
}

function responsesUrl(): string {
  const base = process.env.OPENAI_BASE_URL?.trim().replace(/\/$/, "");
  if (base) return `${base}/responses`;
  return DEFAULT_RESPONSES_URL;
}

function searchModel(): string {
  return process.env.COMPASS_WEB_SEARCH_MODEL?.trim() || "gpt-5.4";
}

function apiKey(): string {
  const key = process.env.COMPASS_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("Thiếu COMPASS_API_KEY / OPENAI_API_KEY");
  return key;
}

function todayIct(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
}

export function buildCompassResearchInput(question: string, sourceHint = "Market: Vietnam. Prefer Vietnamese and English sources."): string {
  return `You research the live web for the user's question. You MUST use the web_search tool before answering.
${sourceHint} Today is ${todayIct()}, not your training cutoff.
Do not invent events, dates, or URLs. If search returns nothing relevant, say so.
Write a short brief in English. For every claim include the publication date (YYYY-MM-DD) and the exact https URL from the search results.
User question:
${question.trim()}`;
}

type SearchSource = { url?: unknown };
type SearchAction = { queries?: unknown; sources?: unknown };
type OutputContent = { type?: unknown; text?: unknown };
type OutputItem = {
  type?: unknown;
  status?: unknown;
  action?: SearchAction;
  content?: OutputContent[];
};

function asItems(value: unknown): OutputItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is OutputItem => !!item && typeof item === "object");
}

export function parseCompassSearchResponse(payload: unknown): CompassWebSearchResult {
  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const output = asItems(root.output);
  const queries: string[] = [];
  const sources: string[] = [];
  let grounded = false;

  for (const item of output) {
    const type = typeof item.type === "string" ? item.type : "";
    if (!type.includes("search") || item.status !== "completed") continue;
    const rawQueries = item.action?.queries;
    if (!Array.isArray(rawQueries)) continue;
    const itemQueries = rawQueries
      .filter((q): q is string => typeof q === "string")
      .map((q) => q.trim())
      .filter((q) => q.length > 0);
    if (itemQueries.length === 0) continue;
    grounded = true;
    queries.push(...itemQueries);
    const rawSources = item.action?.sources;
    if (!Array.isArray(rawSources)) continue;
    for (const source of rawSources as SearchSource[]) {
      const url = source && typeof source.url === "string" ? source.url.trim() : "";
      if (url.startsWith("https://")) sources.push(url);
    }
  }

  let brief = typeof root.output_text === "string" ? root.output_text.trim() : "";
  if (!brief) {
    const parts: string[] = [];
    for (const item of output) {
      if (!Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (part?.type === "output_text" && typeof part.text === "string" && part.text.trim()) {
          parts.push(part.text.trim());
        }
      }
    }
    brief = parts.join("\n").trim();
  }

  return {
    grounded,
    queries: [...new Set(queries)],
    sources: [...new Set(sources)],
    brief,
  };
}

async function postSearch(input: string, maxOutputTokens: number): Promise<CompassWebSearchResult> {
  const response = await fetch(responsesUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: searchModel(),
      input,
      tools: [
        {
          type: "web_search",
          search_context_size: "medium",
          user_location: { type: "approximate", country: "VN", city: "Ho Chi Minh City" },
        },
      ],
      include: ["web_search_call.action.sources"],
      max_output_tokens: maxOutputTokens,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Compass web search HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Compass web search trả về body không phải JSON");
  }
  return parseCompassSearchResponse(payload);
}

/** One Compass /responses call. Retries once with a larger token cap when the search finished but the brief is empty. */
export async function compassWebSearch(
  question: string,
  opts: { sourceHint?: string; maxOutputTokens?: number } = {},
): Promise<CompassWebSearchResult> {
  const input = buildCompassResearchInput(question, opts.sourceHint);
  const cap = opts.maxOutputTokens ?? 4096;
  const first = await postSearch(input, cap);
  if (first.grounded && !first.brief) return postSearch(input, cap * 2);
  return first;
}
