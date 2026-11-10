export function normName(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function bigrams(s: string): string[] {
  if (s.length < 2) return [s];
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

function dice(a: string, b: string): number {
  const x = bigrams(a);
  const counts = new Map<string, number>();
  for (const g of x) counts.set(g, (counts.get(g) ?? 0) + 1);
  let overlap = 0;
  const y = bigrams(b);
  for (const g of y) {
    const n = counts.get(g) ?? 0;
    if (n > 0) {
      overlap++;
      counts.set(g, n - 1);
    }
  }
  return (2 * overlap) / (x.length + y.length);
}

/** 1 = same name after normalisation; containment scores 0.6–0.9 by length ratio; otherwise bigram Dice × 0.85. */
export function nameSimilarity(a: string, b: string): number {
  const x = normName(a);
  const y = normName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) {
    const ratio = Math.min(x.length, y.length) / Math.max(x.length, y.length);
    return 0.6 + 0.3 * ratio;
  }
  return dice(x, y) * 0.85;
}

export function bestSimilarity(queries: string[], names: string[]): { score: number; query: string | null; name: string | null } {
  let best = { score: 0, query: null as string | null, name: null as string | null };
  for (const q of queries) {
    for (const n of names) {
      const s = nameSimilarity(q, n);
      if (s > best.score) best = { score: s, query: q, name: n };
    }
  }
  return best;
}

const BRACKETS = /[（(【\[「《][^）)】\]」》]*[）)】\]」》]/g;
const SEPARATORS = ["：", ":", "—", " - ", "·", "｜", "|"];

/** Search variants of a TapTap title: as-is, without bracketed suffixes, and the head before a subtitle separator. */
export function titleVariants(title: string): string[] {
  const t = title.normalize("NFKC").trim();
  const out = new Set<string>([t]);
  const bare = t.replace(BRACKETS, "").trim();
  if (bare) out.add(bare);
  for (const sep of SEPARATORS) {
    const head = bare.split(sep)[0]?.trim();
    if (head && head.length >= 2 && head !== bare) out.add(head);
  }
  return [...out].filter((s) => s.length >= 2).slice(0, 4);
}

export function hasCjk(value: string): boolean {
  return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(value);
}
