import { describe, expect, it } from "vitest";
import { MAX_CURRICULUM_PARTS, mergeCurriculumDrafts, planCurriculumParts } from "../../src/lib/content/chunking";
import { validateCurriculumDraft } from "../../src/lib/llm/schemas";
import type { CurriculumDraft } from "../../src/lib/llm/types";

const pages = (sizes: number[]) => sizes.map((n, i) => ({ page: i + 1, text: "x".repeat(n) }));

describe("planCurriculumParts", () => {
  it("keeps a document under the target in one part", () => {
    const plan = planCurriculumParts(pages([1000, 2000, 3000]), 60_000);
    expect(plan).toMatchObject({ ok: true, parts: [{ index: 1, total: 1, firstPage: 1, lastPage: 3, chars: 6000 }] });
  });

  it("splits into balanced runs of whole consecutive pages, covering every page once", () => {
    const plan = planCurriculumParts(pages(Array(50).fill(3200)), 60_000);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.parts.length).toBe(3);
    expect(plan.parts.flatMap((p) => p.pages.map((x) => x.page))).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    // Balanced: no tiny trailing part.
    const sizes = plan.parts.map((p) => p.chars);
    expect(Math.min(...sizes) / Math.max(...sizes)).toBeGreaterThan(0.6);
    for (const p of plan.parts) expect(p.lastPage - p.firstPage + 1).toBe(p.pages.length);
  });

  it("never exceeds the hard cap per part and rejects a single page over it", () => {
    const plan = planCurriculumParts(pages([50_000, 50_000, 50_000]), 60_000, 80_000);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.parts.every((p) => p.chars <= 80_000)).toBe(true);
    expect(planCurriculumParts(pages([1000, 90_000]), 60_000, 80_000)).toMatchObject({ ok: false, reason: expect.stringMatching(/page 2 alone/) });
  });

  it(`rejects documents that would need more than ${MAX_CURRICULUM_PARTS} parts`, () => {
    expect(planCurriculumParts(pages(Array(50).fill(12_000)), 60_000)).toMatchObject({ ok: false, reason: expect.stringMatching(/drafting requests/) });
  });
});

describe("mergeCurriculumDrafts", () => {
  const unit = (title: string, page: number) => ({ title, objective: `Do ${title}`, sourcePages: [page], skills: [{ objective: "s" }] });
  it("joins a topic that continues across parts and de-duplicates suggestions", () => {
    const a: CurriculumDraft = { topics: [{ title: "Likelihood", units: [unit("a", 1)] }], suggestions: ["Read Bishop 4.3"] };
    const b: CurriculumDraft = {
      topics: [
        { title: " likelihood ", units: [unit("b", 20)] },
        { title: "Losses", units: [unit("c", 22)] },
      ],
      suggestions: ["read bishop 4.3", "Try logits"],
    };
    const m = mergeCurriculumDrafts([a, b]);
    expect(m.topics.map((t) => t.title)).toEqual(["Likelihood", "Losses"]);
    expect(m.topics[0].units.map((u) => u.title)).toEqual(["a", "b"]);
    expect(m.suggestions).toEqual(["Read Bishop 4.3", "Try logits"]);
    // Inputs are not mutated.
    expect(a.topics[0].units).toHaveLength(1);
  });
});

describe("validateCurriculumDraft unit counts", () => {
  const draft = (n: number): CurriculumDraft => ({
    topics: [{ title: "T", units: Array.from({ length: n }, (_, i) => ({ title: `U${i}`, objective: "o", sourcePages: [1], skills: [{ objective: "s" }] })) }],
    suggestions: [],
  });
  it("asks a whole document for 3-8 units, but no more than its page count below 3", () => {
    expect(validateCurriculumDraft(draft(2), { pages: [1, 2, 3] })).toEqual(["expected 3-8 units, got 2"]);
    expect(validateCurriculumDraft(draft(2), { pages: [1, 2] })).toEqual([]);
    expect(validateCurriculumDraft(draft(1), { pages: [1] })).toEqual([]);
    expect(validateCurriculumDraft(draft(1), { pages: [1, 2, 3], part: true })).toEqual([]);
  });
});
