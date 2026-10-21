// Draft review: which source pages no unit cites. Pure; used by the course screen while a draft is edited.

/** Pages of the source that no unit cites, in page order. */
export function uncoveredPages(pages: number[], citedPages: Iterable<number>): number[] {
  const cited = new Set(citedPages);
  return [...new Set(pages)].filter((p) => !cited.has(p)).sort((a, b) => a - b);
}

/** "1–5, 11–13, 19" for [1,2,3,4,5,11,12,13,19]. */
export function formatPageRanges(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    ranges.push(j === i ? `${sorted[i]}` : `${sorted[i]}–${sorted[j]}`);
    i = j + 1;
  }
  return ranges.join(", ");
}
