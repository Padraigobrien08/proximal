// Keyword retrieval over lecture pages (BM25). Pure. Lecture-sized corpora (tens of pages) need nothing heavier.

const STOP = new Set(
  "a an and are as at be but by can do does for from how i if in into is it its me my of on or so that the their them then there these this to was we what when where which who why will with you your about explain mean means please tell".split(
    " ",
  ),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 1 && !STOP.has(t)).map(stem);
}

/** Very light stemming so "models"/"model" and "classified"/"classify" meet. */
function stem(t: string): string {
  if (t.length > 4 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length > 5 && t.endsWith("ing")) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith("ed")) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

export interface RankedDoc<T> {
  doc: T;
  score: number;
}

/** BM25 ranking (k1 = 1.2, b = 0.75). Documents with no query term score 0 and are dropped. */
export function rankBm25<T>(docs: T[], text: (d: T) => string, query: string): RankedDoc<T>[] {
  const q = [...new Set(tokenize(query))];
  if (q.length === 0 || docs.length === 0) return [];
  const toks = docs.map((d) => tokenize(text(d)));
  const avg = toks.reduce((n, t) => n + t.length, 0) / docs.length || 1;
  const df = new Map(q.map((term) => [term, toks.filter((t) => t.includes(term)).length]));
  const k1 = 1.2;
  const b = 0.75;
  return docs
    .map((doc, i) => {
      const t = toks[i];
      let score = 0;
      for (const term of q) {
        const f = t.filter((x) => x === term).length;
        if (!f) continue;
        const n = df.get(term)!;
        const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * t.length) / avg)));
      }
      return { doc, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b2) => b2.score - a.score);
}
