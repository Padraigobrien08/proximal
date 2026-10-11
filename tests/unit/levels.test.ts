import { describe, expect, it } from "vitest";
import { LEVELS, levelOf, rollup, subtopicLevel } from "../../src/lib/domain/levels";
import { EVIDENCE_LABELS } from "../../src/lib/domain/labels";

describe("mastery levels", () => {
  it("maps each evidence state to one level, in order", () => {
    expect(levelOf("unassessed")).toBe(0);
    expect(levelOf("developing")).toBe(1);
    expect(levelOf("supported")).toBe(2);
    expect(levelOf("demonstrated_once")).toBe(3);
    expect(levelOf("retention_demonstrated")).toBe(4);
    expect(EVIDENCE_LABELS.supported.label).toBe(LEVELS[2].name);
  });

  it("a subtopic is as strong as its weakest required skill", () => {
    expect(
      subtopicLevel([
        { required: true, evidenceState: "retention_demonstrated" },
        { required: true, evidenceState: "supported" },
        { required: false, evidenceState: "unassessed" },
      ]),
    ).toBe(2);
    // Without required skills, every skill counts.
    expect(subtopicLevel([{ required: false, evidenceState: "demonstrated_once" }, { required: false, evidenceState: "developing" }])).toBe(1);
    expect(subtopicLevel([])).toBe(0);
  });

  it("rolls up as counts per level, never an average", () => {
    const r = rollup([
      { level: 3, due: true },
      { level: 4, due: false },
      { level: 0, due: false },
      { level: 2, due: false },
    ]);
    expect(r).toEqual({ counts: [1, 0, 1, 1, 1], total: 4, checked: 2, due: 1 });
  });
});
