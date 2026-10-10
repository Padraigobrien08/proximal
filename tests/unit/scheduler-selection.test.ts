import { describe, expect, it } from "vitest";
import { selectQuestion } from "../../src/lib/domain/selection";
import { dueLabel } from "../../src/lib/domain/labels";
import { MS_DAY, MS_HOUR } from "../../src/lib/domain/types";
import { T0 } from "../helpers";

describe("selection", () => {
  const qs = [
    { id: "S5-A", skillId: "S5", familyId: "fa", isTransfer: false, status: "authored_fixture" as const },
    { id: "S5-B", skillId: "S5", familyId: "fb", isTransfer: true, status: "authored_fixture" as const },
  ];
  it("prefers never-attempted families, initial before transfer", () => {
    expect(selectQuestion(qs, new Map())?.questionId).toBe("S5-A");
    expect(selectQuestion(qs, new Map([["fa", T0]]))?.questionId).toBe("S5-B");
  });
  it("practice reuses the most recently attempted family, keeping fresh families for checks", () => {
    expect(selectQuestion(qs, new Map([["fa", T0]]), "practice")?.questionId).toBe("S5-A");
    expect(selectQuestion(qs, new Map(), "practice")?.questionId).toBe("S5-A");
  });
  it("falls back to least recently attempted and flags repeated family", () => {
    const r = selectQuestion(qs, new Map([["fa", T0], ["fb", T0 - 1000]]));
    expect(r).toEqual({ questionId: "S5-B", familyId: "fb", repeatedFamily: true });
  });
  it("never selects excluded questions", () => {
    expect(selectQuestion([{ ...qs[0], status: "excluded" }], new Map())).toBeNull();
  });
});

describe("labels", () => {
  it("describes due dates in Europe/London", () => {
    const now = Date.parse("2026-10-12T20:00:00Z");
    expect(dueLabel(now + MS_DAY, now, "Europe/London")).toBe("Review due tomorrow");
    expect(dueLabel(now - MS_HOUR, now, "Europe/London")).toBe("Review due now");
  });
});
