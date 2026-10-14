import { describe, expect, it } from "vitest";
import { buildStudyPlan, isUnfinished, type PlanSession, type PlanSkill } from "../../src/lib/domain/plan";
import { MS_DAY, MS_HOUR } from "../../src/lib/domain/types";
import { T0 } from "../helpers";

let n = 0;
const skill = (over: Partial<PlanSkill>): PlanSkill => {
  n += 1;
  return {
    skillId: `K${n}`,
    objective: `objective ${n}`,
    primaryTaskType: "explain",
    courseId: "C",
    topicId: "T1",
    topicTitle: "Topic 1",
    order: n,
    required: true,
    evidenceState: "unassessed",
    dueAt: null,
    reassessmentNeeded: false,
    attempted: false,
    reviewAvailable: true,
    learnAvailable: true,
    ...over,
  };
};

const session = (over: Partial<PlanSession>): PlanSession => ({
  sessionId: "sess",
  courseId: "C",
  topicId: "T3",
  topicTitle: "Binary cross-entropy",
  mode: "review",
  purpose: "check",
  phase: "checkpoint",
  lastActivityAt: T0,
  answered: 1,
  total: 2,
  pendingAssessments: 0,
  providerErrors: 0,
  feedbackReleased: false,
  unresolvedRepairSkillIds: [],
  skillIds: ["S4", "S5"],
  remainingQuestions: 0,
  ...over,
});

describe("study plan", () => {
  it("U01: a new workspace starts with one real learning action and invents no progress", () => {
    const p = buildStudyPlan({
      now: T0,
      budgetMinutes: 20,
      activeSessions: [],
      skills: [skill({ topicId: "T1", topicTitle: "Binary cross-entropy" }), skill({ topicId: "T1", topicTitle: "Binary cross-entropy" })],
    });
    expect(p.recommendation).toMatchObject({ action: "learn", title: "Start learning", topicTitle: "Binary cross-entropy", reason: "Not studied yet" });
    expect(p.plan).toHaveLength(1);
    expect(p.nextScheduledCheck).toBeNull();
  });

  it("U08: the most recent unfinished session is resumed rather than duplicated, with phase-specific wording", () => {
    const base = { now: T0, budgetMinutes: 20, skills: [skill({})] };
    const checkpoint = buildStudyPlan({ ...base, activeSessions: [session({})] });
    expect(checkpoint.recommendation).toMatchObject({ action: "resume", title: "Continue your quick check", reason: "1 of 2 answers saved", sessionId: "sess" });
    const pending = buildStudyPlan({ ...base, activeSessions: [session({ phase: "results", answered: 2, pendingAssessments: 1, providerErrors: 1 })] });
    expect(pending.recommendation).toMatchObject({ title: "Your answer is saved", reason: "Assessment needs another attempt" });
    const repair = buildStudyPlan({
      now: T0,
      budgetMinutes: 20,
      skills: [skill({ skillId: "S5", primaryTaskType: "calculate" })],
      activeSessions: [session({ phase: "repair", answered: 2, feedbackReleased: true, unresolvedRepairSkillIds: ["S5"] })],
    });
    expect(repair.recommendation).toMatchObject({ title: "Continue the calculation practice", reason: "Your original answer is saved" });
    // A repaired session is finished: it is not recommended again.
    expect(isUnfinished(session({ phase: "repair", unresolvedRepairSkillIds: [] }))).toBe(false);
    const latest = buildStudyPlan({
      ...base,
      activeSessions: [session({ sessionId: "old", lastActivityAt: T0 - MS_HOUR }), session({ sessionId: "new", lastActivityAt: T0 })],
    });
    expect(latest.recommendation?.sessionId).toBe("new");
  });

  it("U09: due review beats new learning; future reviews stay outside today's plan; unassessed is not a failure", () => {
    const p = buildStudyPlan({
      now: T0,
      budgetMinutes: 30,
      activeSessions: [],
      skills: [
        skill({ topicId: "T1", topicTitle: "New topic" }),
        skill({ topicId: "T2", topicTitle: "Due topic", evidenceState: "demonstrated_once", attempted: true, dueAt: T0 - MS_HOUR }),
        skill({ topicId: "T3", topicTitle: "Future topic", evidenceState: "supported", attempted: true, dueAt: T0 + MS_DAY }),
        skill({ topicId: "T4", topicTitle: "Reassess", evidenceState: "developing", attempted: true, reassessmentNeeded: true, dueAt: T0 - 1 }),
      ],
    });
    expect(p.plan.map((t) => [t.topicTitle, t.action])).toEqual([
      ["Reassess", "review"],
      ["Due topic", "review"],
      ["New topic", "learn"],
    ]);
    expect(p.plan.some((t) => t.topicTitle === "Future topic")).toBe(false);
    expect(p.nextScheduledCheck).toMatchObject({ topicTitle: "Future topic", dueAt: T0 + MS_DAY });
    expect(p.plan.find((t) => t.topicTitle === "New topic")?.reason).toBe("Not studied yet");
  });

  it("an unresolved gap gets targeted practice; a completed repair is not repeated", () => {
    const gap = buildStudyPlan({
      now: T0,
      budgetMinutes: 20,
      activeSessions: [],
      skills: [skill({ skillId: "S5", primaryTaskType: "calculate", topicTitle: "Binary cross-entropy", evidenceState: "developing", attempted: true, reassessmentNeeded: true, dueAt: T0 + MS_DAY })],
    });
    expect(gap.recommendation).toMatchObject({ action: "practice", title: "Practise the calculation", topicTitle: "Binary cross-entropy", reason: "Your last calculation needs another step" });
    const repaired = buildStudyPlan({
      now: T0,
      budgetMinutes: 20,
      activeSessions: [],
      skills: [skill({ skillId: "S5", primaryTaskType: "calculate", evidenceState: "supported", attempted: true, reassessmentNeeded: true, dueAt: T0 + MS_DAY })],
    });
    expect(repaired.plan).toHaveLength(0);
    expect(repaired.upToDate).toBe(true);
    expect(repaired.recommendation).toMatchObject({ action: "view", title: "Your next check is scheduled", dueAt: T0 + MS_DAY });
  });

  it("AC11: due skills group by topic into at most three blocks with reasons; a long-overdue topic surfaces first", () => {
    const due = (topicId: string, topicTitle: string, dueAt: number, over: Partial<PlanSkill> = {}) =>
      skill({ topicId, topicTitle, evidenceState: "demonstrated_once", attempted: true, dueAt, ...over });
    const skills = [
      due("T1", "Recently due", T0 - MS_HOUR),
      due("T1", "Recently due", T0 - MS_HOUR, { primaryTaskType: "calculate" }),
      due("T2", "Due yesterday", T0 - MS_DAY),
      due("T3", "Due today", T0 - 2 * MS_HOUR),
      due("T4", "Due this morning", T0 - 3 * MS_HOUR),
      due("T9", "Long overdue", T0 - 60 * MS_DAY), // listed last: order must not hide it
    ];
    const p = buildStudyPlan({ now: T0, budgetMinutes: 30, activeSessions: [], skills });

    expect(p.plan.length).toBeLessThanOrEqual(3);
    expect(p.plan[0]).toMatchObject({ topicTitle: "Long overdue", action: "review", dueAt: T0 - 60 * MS_DAY });
    expect(p.recommendation?.topicTitle).toBe("Long overdue");
    expect(p.plan.map((t) => t.topicTitle)).toEqual(["Long overdue", "Due yesterday", "Due this morning"]);
    for (const t of p.plan) expect(t.reason).toMatch(/\S/);
    // Grouped by topic: one block per topic, never one per skill.
    expect(new Set(p.plan.map((t) => t.topicId)).size).toBe(p.plan.length);

    const grouped = buildStudyPlan({ now: T0, budgetMinutes: 30, activeSessions: [], skills: skills.filter((s) => s.topicId === "T1") });
    expect(grouped.plan).toHaveLength(1);
    expect(grouped.plan[0].skillIds).toHaveLength(2);
    expect(grouped.plan[0].reason).toBe("Scheduled check is due");
  });

  it("AC11: per spec, reassessment outranks a long-overdue review; the overdue topic returns once those are done", () => {
    const reassess = (topicId: string) =>
      skill({ topicId, topicTitle: topicId, evidenceState: "developing", attempted: true, reassessmentNeeded: true, dueAt: T0 - MS_HOUR });
    const overdue = skill({ topicId: "T9", topicTitle: "Long overdue", evidenceState: "demonstrated_once", attempted: true, dueAt: T0 - 60 * MS_DAY });
    const busy = buildStudyPlan({ now: T0, budgetMinutes: 30, activeSessions: [], skills: [reassess("R1"), reassess("R2"), reassess("R3"), overdue] });
    expect(busy.plan.map((t) => t.topicId)).toEqual(["R1", "R2", "R3"]);
    for (const t of busy.plan) expect(t.reason).toBe("Explanation needs another check");

    const after = buildStudyPlan({ now: T0, budgetMinutes: 30, activeSessions: [], skills: [overdue] });
    expect(after.plan[0]).toMatchObject({ topicId: "T9", action: "review", reason: "Scheduled explanation check is due" });
  });

  it("U10: the 10/20/30 budget changes task coverage when enough work exists; one task stays one task", () => {
    const many = [
      skill({ topicId: "A", topicTitle: "A" }),
      skill({ topicId: "A", topicTitle: "A" }),
      skill({ topicId: "B", topicTitle: "B" }),
      skill({ topicId: "C", topicTitle: "C" }),
      skill({ topicId: "C", topicTitle: "C" }),
    ];
    const sizes = [10, 20, 30].map((b) => {
      const p = buildStudyPlan({ now: T0, budgetMinutes: b, activeSessions: [], skills: many });
      return { tasks: p.plan.map((t) => `${t.topicTitle}:${t.skillIds.length}`), minutes: p.totalMinutes };
    });
    expect(sizes).toEqual([
      { tasks: ["A:2"], minutes: 10 },
      { tasks: ["A:2", "B:1", "C:1"], minutes: 20 },
      { tasks: ["A:2", "B:1", "C:2"], minutes: 25 },
    ]);
    const single = buildStudyPlan({ now: T0, budgetMinutes: 30, activeSessions: [], skills: [skill({ topicId: "Z" })] });
    expect(single.plan).toHaveLength(1);
    expect(single.totalMinutes).toBe(5);
  });

  it("an oversize first task is trimmed to a meaningful segment; a critical due task is not skipped for smaller work", () => {
    const due = [1, 2, 3].map(() => skill({ topicId: "D", topicTitle: "Due", evidenceState: "demonstrated_once", attempted: true, dueAt: T0 - MS_DAY }));
    const p = buildStudyPlan({ now: T0, budgetMinutes: 10, activeSessions: [], skills: [...due, skill({ topicId: "N", topicTitle: "New" })] });
    expect(p.plan.map((t) => `${t.topicTitle}:${t.skillIds.length}`)).toEqual(["Due:2"]);
    expect(p.totalMinutes).toBe(10);
  });

  it("U11: unavailable reviewed questions and future-only states give honest actions", () => {
    const unavailable = buildStudyPlan({
      now: T0,
      budgetMinutes: 20,
      activeSessions: [],
      skills: [skill({ topicTitle: "Imported", reviewAvailable: false, learnAvailable: false })],
    });
    expect(unavailable.recommendation).toMatchObject({ action: "view", title: "Reviewed questions needed" });
    const empty = buildStudyPlan({ now: T0, budgetMinutes: 20, activeSessions: [], skills: [] });
    expect(empty.recommendation).toBeNull();
    expect(empty.upToDate).toBe(true);
  });
});

describe("display copy", () => {
  it("keeps the topic as the heading and builds short focus/summary text from skill labels", () => {
    const p = buildStudyPlan({
      now: T0,
      budgetMinutes: 20,
      activeSessions: [],
      skills: [
        skill({ topicId: "M", topicTitle: "Model and likelihood", label: "Notation", summary: "Interpret the model notation" }),
        skill({ topicId: "M", topicTitle: "Model and likelihood", label: "Dataset likelihood", summary: "Write a dataset likelihood" }),
      ],
    });
    expect(p.recommendation).toMatchObject({
      title: "Start learning",
      topicTitle: "Model and likelihood",
      focus: "Notation and dataset likelihood",
      summary: "Interpret the model notation, then write a dataset likelihood.",
    });
    // Acronyms keep their case; skills without labels fall back to the objective.
    const q = buildStudyPlan({
      now: T0,
      budgetMinutes: 20,
      activeSessions: [],
      skills: [skill({ topicId: "B", label: "BCE meaning" }), skill({ topicId: "B", label: "Loss calculation" }), skill({ topicId: "B", objective: "Derive it" })],
    });
    expect(q.recommendation?.focus).toBe("BCE meaning, loss calculation and derive it");
  });
});
