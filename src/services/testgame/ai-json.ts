import { jsonrepair } from "jsonrepair";

/** Lấy JSON từ câu trả lời LLM (bỏ ```json, sửa JSON lỗi nhẹ). */
export function parseLlmJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  const start = fenced.search(/[[{]/);
  const body = start >= 0 ? fenced.slice(start) : fenced;
  try {
    return JSON.parse(body) as T;
  } catch {
    return JSON.parse(jsonrepair(body)) as T;
  }
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
