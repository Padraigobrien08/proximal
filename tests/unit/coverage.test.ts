import { describe, expect, it } from "vitest";
import { formatPageRanges, uncoveredPages } from "../../src/lib/content/coverage";

describe("draft coverage", () => {
  it("lists pages no unit cites, in order, once each", () => {
    expect(uncoveredPages([1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6])).toEqual([]);
    expect(uncoveredPages([1, 2, 3, 4, 5, 6], [6, 2, 2])).toEqual([1, 3, 4, 5]);
    expect(uncoveredPages([], [1])).toEqual([]);
  });

  it("formats runs of pages as ranges", () => {
    // The ANLP W1/L1 import: units cite 6-10, 14-18, 20, 22, 23 of 32 pages.
    const pages = Array.from({ length: 32 }, (_, i) => i + 1);
    const cited = [6, 7, 8, 9, 10, 14, 15, 16, 17, 18, 20, 22, 23];
    expect(formatPageRanges(uncoveredPages(pages, cited))).toBe("1–5, 11–13, 19, 21, 24–32");
    expect(formatPageRanges([7])).toBe("7");
    expect(formatPageRanges([3, 1, 2, 2])).toBe("1–3");
    expect(formatPageRanges([])).toBe("");
  });
});
