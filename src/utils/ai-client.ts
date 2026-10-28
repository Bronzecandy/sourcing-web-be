import OpenAI from "openai";

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY!,
      baseURL: process.env.OPENAI_BASE_URL || undefined,
    });
  }
  return _client;
}

export function getModel(): string {
  return process.env.OPENAI_MODEL || "gpt-5.4";
}

export interface LLMResponse {
  content: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

export async function callLLM(
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number = 16_384,
  opts: { temperature?: number } = {},
): Promise<LLMResponse> {
  const model = getModel();
  const client = getClient();

  // gpt-5.x từ chối max_tokens; quota này gồm cả token suy luận.
  const tokenLimit = model.startsWith("gpt-5")
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
  const response = await client.chat.completions.create({
    model,
    ...tokenLimit,
    ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("LLM returned no content");

  return {
    content,
    model: response.model ?? model,
    inputTokens: response.usage?.prompt_tokens,
    outputTokens: response.usage?.completion_tokens,
  };
}
