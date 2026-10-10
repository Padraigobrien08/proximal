import { describe, expect, it } from "vitest";
import { buildQueue, type QueueSkillInput } from "../../src/lib/domain/scheduler";
import { selectQuestion } from "../../src/lib/domain/selection";
import { dueLabel } from "../../src/lib/domain/labels";
import { MS_DAY, MS_HOUR } from "../../src/lib/domain/types";
import { T0 } from "../helpers";

const skill = (over: Partial<QueueSkillInput>): QueueSkillInput => ({
  skillId: "S",
  objective: "obj",
  topicId: "T1",
  topicTitle: "Topic 1",
  topicPosition: 1,
  evidenceState: "unassessed",
  dueAt: null,
  reassessmentNeeded: false,
  transferRequired: true,
  transferCovered: false,
  attempted: false,
  reviewAvailable: true,
  ...over,
});

describe("queue", () => {
  it("T17: groups by topic (max 3 blocks), orders reassessment-due first, shows reasons, and is read-only", () => {
    const skills = [
      skill({ skillId: "new1", topicId: "T4", topicTitle: "Topic 4", topicPosition: 4 }),
      skill({ skillId: "due-old", topicId: "T2", topicTitle: "Topic 2", topicPosition: 2, evidenceState: "demonstrated_once", attempted: true, dueAt: T0 - 5 * MS_DAY }),
      skill({ skillId: "reassess", topicId: "T3", topicTitle: "Topic 3", topicPosition: 3, evidenceState: "developing", attempted: true, dueAt: T0 - MS_HOUR, reassessmentNeeded: true }),
      skill({ skillId: "due-new", topicId: "T2", topicTitle: "Topic 2", topicPosition: 2, evidenceState: "demonstrated_once", attempted: true, dueAt: T0 - MS_HOUR }),
      skill({ skillId: "new2", topicId: "T5", topicTitle: "Topic 5", topicPosition: 5 }),
    ];
    const frozen = JSON.stringify(skills);
    const q = buildQueue(skills, T0, 30);
    expect(q.length).toBeLessThanOrEqual(3);
    expect(q[0].topicId).toBe("T3");
    expect(q[0].items[0].reason).toBe("reassessment_due");
    expect(q[1].topicId).toBe("T2");
    expect(q[1].items.map((i) => i.skillId)).toEqual(["due-old", "due-new"]);
    expect(q[1].reasons).toContain("Scheduled review is due");
    expect(q.every((b) => b.reasons.length > 0)).toBe(true);
    expect(JSON.stringify(skills)).toBe(frozen); // overdue does not change evidence
  });

  it("budget limits questions at ~5 minutes each", () => {
    const skills = Array.from({ length: 6 }, (_, i) => skill({ skillId: `s${i}`, topicId: "T1" }));
    const q = buildQueue(skills, T0, 10);
    expect(q[0].items).toHaveLength(2);
    expect(q[0].estimatedMinutes).toBe(10);
  });

  it("scheduled-but-not-yet-due skills wait rather than being requeued early", () => {
    const q = buildQueue([skill({ attempted: true, evidenceState: "supported", dueAt: T0 + MS_DAY })], T0, 30);
    expect(q).toHaveLength(0);
  });
});

describe("selection", () => {
  const qs = [
    { id: "S5-A", skillId: "S5", familyId: "fa", isTransfer: false, status: "authored_fixture" as const },
    { id: "S5-B", skillId: "S5", familyId: "fb", isTransfer: true, status: "authored_fixture" as const },
  ];
  it("prefers never-attempted families, initial before transfer", () => {
    expect(selectQuestion(qs, new Map())?.questionId).toBe("S5-A");
    expect(selectQuestion(qs, new Map([["fa", T0]]))?.questionId).toBe("S5-B");
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
