import { describe, expect, it } from "vitest";
import { rankBm25, tokenize } from "../../src/lib/domain/retrieval";

describe("lecture retrieval", () => {
  it("drops stop words and folds simple plurals", () => {
    expect(tokenize("What are the models of classification?")).toEqual(["model", "classification"]);
  });

  it("ranks pages by keyword relevance and drops pages with no match", () => {
    const pages = [
      { id: 1, text: "Course logistics and assessment dates." },
      { id: 2, text: "Binary cross-entropy penalises confident wrong predictions. Cross-entropy versus accuracy." },
      { id: 3, text: "Accuracy counts correct predictions." },
    ];
    const ranked = rankBm25(pages, (p) => p.text, "how does cross-entropy differ from accuracy");
    expect(ranked.map((r) => r.doc.id)).toEqual([2, 3]);
  });
});
