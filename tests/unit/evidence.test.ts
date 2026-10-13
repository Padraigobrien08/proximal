import { describe, expect, it } from "vitest";
import { qualifiesAsIndependent, replaySkill } from "../../src/lib/domain/evidence";
import { MS_DAY, MS_HOUR } from "../../src/lib/domain/types";
import { ea, T0 } from "../helpers";

const policy = { transferRequired: true };

describe("evidence reducer", () => {
  it("T01: first valid independent pass -> demonstrated_once, stage 0, due +24h", () => {
    const s = replaySkill([ea({ sessionId: "s1", submittedAt: T0 })], policy);
    expect(s.evidenceState).toBe("demonstrated_once");
    expect(s.stage).toBe(0);
    expect(s.dueAt).toBe(T0 + MS_DAY);
    expect(s.reassessmentNeeded).toBe(false);
  });

  it("T02 (reducer): exposure before answer makes a correct response supported, no promotion", () => {
    const s = replaySkill([ea({ sessionId: "s1", submittedAt: T0, exposedBeforeSubmission: true })], policy);
    expect(s.evidenceState).toBe("supported");
    expect(s.stage).toBeNull();
    expect(s.dueAt).toBe(T0 + MS_DAY);
  });

  it("declared assistance and learning mode never qualify; confidence is not an input", () => {
    expect(qualifiesAsIndependent(ea({ sessionId: "s", submittedAt: T0, declaredAssistance: true }))).toBe(false);
    expect(qualifiesAsIndependent(ea({ sessionId: "s", submittedAt: T0, mode: "learn" }))).toBe(false);
    expect(qualifiesAsIndependent(ea({ sessionId: "s", submittedAt: T0, phase: "repair" }))).toBe(false);
    expect(qualifiesAsIndependent(ea({ sessionId: "s", submittedAt: T0 }))).toBe(true);
  });

  it("T06: two passes 23h59m apart cannot establish retention or advance stage", () => {
    const s = replaySkill(
      [
        ea({ sessionId: "s1", submittedAt: T0, familyId: "A" }),
        ea({ sessionId: "s2", submittedAt: T0 + MS_DAY - 60_000, familyId: "B", isTransfer: true }),
      ],
      policy,
    );
    expect(s.evidenceState).toBe("demonstrated_once");
    expect(s.stage).toBe(0);
    expect(s.dueAt).toBe(T0 + MS_DAY);
  });

  it("T07: distinct-family passes exactly 24h apart in different sessions establish retention only with transfer", () => {
    const withTransfer = replaySkill(
      [
        ea({ sessionId: "s1", submittedAt: T0, familyId: "A" }),
        ea({ sessionId: "s2", submittedAt: T0 + MS_DAY, familyId: "B", isTransfer: true }),
      ],
      policy,
    );
    expect(withTransfer.evidenceState).toBe("retention_demonstrated");
    expect(withTransfer.stage).toBe(1);
    expect(withTransfer.dueAt).toBe(T0 + MS_DAY + 3 * MS_DAY);

    const noTransfer = replaySkill(
      [
        ea({ sessionId: "s1", submittedAt: T0, familyId: "A" }),
        ea({ sessionId: "s2", submittedAt: T0 + MS_DAY, familyId: "C", isTransfer: false }),
      ],
      policy,
    );
    expect(noTransfer.evidenceState).toBe("demonstrated_once");
    expect(noTransfer.stage).toBe(1); // stage may advance; retention gate still needs transfer coverage
    expect(noTransfer.transferCovered).toBe(false);

    const notRequired = replaySkill(
      [
        ea({ sessionId: "s1", submittedAt: T0, familyId: "A" }),
        ea({ sessionId: "s2", submittedAt: T0 + MS_DAY, familyId: "C" }),
      ],
      { transferRequired: false },
    );
    expect(notRequired.evidenceState).toBe("retention_demonstrated");
  });

  it("T08: repeated-family passes cannot satisfy the distinct-family gate (stage may still advance)", () => {
    const s = replaySkill(
      [
        ea({ sessionId: "s1", submittedAt: T0, familyId: "B", isTransfer: true }),
        ea({ sessionId: "s2", submittedAt: T0 + 2 * MS_DAY, familyId: "B", isTransfer: true }),
      ],
      policy,
    );
    expect(s.evidenceState).toBe("demonstrated_once");
    expect(s.stage).toBe(1);
  });

  it("T09: additional same-session pass cannot push due date or stage repeatedly", () => {
    const first = ea({ sessionId: "s1", submittedAt: T0, familyId: "A" });
    const later = ea({ sessionId: "s2", submittedAt: T0 + 2 * MS_DAY, familyId: "B", isTransfer: true });
    const sameSession = ea({ sessionId: "s2", submittedAt: T0 + 2 * MS_DAY + MS_HOUR, familyId: "C" });
    const s = replaySkill([first, later, sameSession], policy);
    expect(s.stage).toBe(1);
    expect(s.dueAt).toBe(T0 + 2 * MS_DAY + 3 * MS_DAY);
  });

  it("AC08: three distinct-family passes in separate sessions on one day give one advance, no retention, no due extension", () => {
    const s = replaySkill(
      [
        ea({ sessionId: "s1", submittedAt: T0, familyId: "A" }),
        ea({ sessionId: "s2", submittedAt: T0 + 4 * MS_HOUR, familyId: "B", isTransfer: true }),
        ea({ sessionId: "s3", submittedAt: T0 + 8 * MS_HOUR, familyId: "C" }),
      ],
      policy,
    );
    expect(s.evidenceState).toBe("demonstrated_once");
    expect(s.stage).toBe(0);
    expect(s.dueAt).toBe(T0 + MS_DAY);
    expect(s.currentEpochPasses).toHaveLength(3); // kept for coverage and history

    // The next qualifying pass is measured from the first promotion, not the latest same-day pass.
    const next = replaySkill(
      [
        ea({ sessionId: "s1", submittedAt: T0, familyId: "A" }),
        ea({ sessionId: "s2", submittedAt: T0 + 8 * MS_HOUR, familyId: "B" }),
        ea({ sessionId: "s3", submittedAt: T0 + MS_DAY, familyId: "C", isTransfer: true }),
      ],
      policy,
    );
    expect(next.stage).toBe(1);
    expect(next.evidenceState).toBe("retention_demonstrated");
  });

  it("T10: independent partial/fail starts a new epoch and keeps reassessment flag; history input unchanged", () => {
    const attempts = [
      ea({ sessionId: "s1", submittedAt: T0, familyId: "A" }),
      ea({ sessionId: "s2", submittedAt: T0 + 2 * MS_DAY, familyId: "B", isTransfer: true, outcome: "fail" }),
    ];
    const snapshot = JSON.stringify(attempts);
    const s = replaySkill(attempts, policy);
    expect(s.epoch).toBe(1);
    expect(s.stage).toBe(0);
    expect(s.dueAt).toBe(T0 + 2 * MS_DAY + MS_DAY);
    expect(s.reassessmentNeeded).toBe(true);
    expect(s.evidenceState).toBe("developing");
    expect(s.currentEpochPasses).toHaveLength(0);
    expect(JSON.stringify(attempts)).toBe(snapshot);

    // First subsequent independent pass clears reassessment and re-establishes demonstrated_once.
    const after = replaySkill(
      [...attempts, ea({ sessionId: "s3", submittedAt: T0 + 4 * MS_DAY, familyId: "A" })],
      policy,
    );
    expect(after.reassessmentNeeded).toBe(false);
    expect(after.evidenceState).toBe("demonstrated_once");
  });

  it("T11: supported failure cannot erase an earlier independent success", () => {
    const s = replaySkill(
      [
        ea({ sessionId: "s1", submittedAt: T0 }),
        ea({ sessionId: "s2", submittedAt: T0 + MS_HOUR, mode: "learn", outcome: "fail" }),
      ],
      policy,
    );
    expect(s.evidenceState).toBe("demonstrated_once");
    expect(s.epoch).toBe(0);
    expect(s.reassessmentNeeded).toBe(false);
  });

  it("T12: uncertain/excluded judgements make no update; exclusion after promotion rebuilds", () => {
    const pass1 = ea({ sessionId: "s1", submittedAt: T0, familyId: "A" });
    const pass2 = ea({ sessionId: "s2", submittedAt: T0 + MS_DAY, familyId: "B", isTransfer: true });
    expect(replaySkill([pass1, pass2], policy).evidenceState).toBe("retention_demonstrated");
    const excluded = replaySkill([pass1, { ...pass2, excluded: true }], policy);
    expect(excluded.evidenceState).toBe("demonstrated_once");
    expect(excluded.stage).toBe(0);
    expect(excluded.dueAt).toBe(T0 + MS_DAY);
    const uncertain = replaySkill([{ ...pass1, outcome: "uncertain" }], policy);
    expect(uncertain.evidenceState).toBe("unassessed");
    expect(uncertain.dueAt).toBeNull();
    const invalid = replaySkill([{ ...pass1, validity: "invalid" }], policy);
    expect(invalid.evidenceState).toBe("unassessed");
    const pending = replaySkill([{ ...pass1, outcome: null }], policy);
    expect(pending.evidenceState).toBe("unassessed");
  });

  it("T14: replay is by submission order, independent of input (completion) order", () => {
    const a = ea({ sessionId: "s1", submittedAt: T0, familyId: "A", outcome: "fail" });
    const b = ea({ sessionId: "s2", submittedAt: T0 + 2 * MS_DAY, familyId: "B", isTransfer: true });
    expect(replaySkill([b, a], policy)).toEqual(replaySkill([a, b], policy));
  });

  it("supported attempt sets due to earlier(existing, +1 day) without stage advance", () => {
    const s = replaySkill(
      [
        ea({ sessionId: "s1", submittedAt: T0 }),
        ea({ sessionId: "s2", submittedAt: T0 + 3 * MS_HOUR, mode: "learn" }),
      ],
      policy,
    );
    expect(s.stage).toBe(0);
    expect(s.dueAt).toBe(T0 + MS_DAY);
  });

  it("a lapse does not grant an extra promotion in the same session", () => {
    const s = replaySkill(
      [
        ea({ sessionId: "s1", submittedAt: T0, familyId: "A" }),
        ea({ sessionId: "s2", submittedAt: T0 + 2 * MS_DAY, familyId: "B", isTransfer: true }),
        ea({ sessionId: "s2", submittedAt: T0 + 2 * MS_DAY + 1000, familyId: "C", outcome: "fail" }),
        ea({ sessionId: "s2", submittedAt: T0 + 2 * MS_DAY + 2000, familyId: "D" }),
      ],
      policy,
    );
    expect(s.epoch).toBe(1);
    expect(s.stage).toBe(0);
    expect(s.evidenceState).toBe("demonstrated_once");
  });

  it("T21: Europe/London spring-forward does not turn <24 elapsed hours into a qualifying delay", () => {
    // 28 Mar 2026 12:00 GMT, then 29 Mar 2026 12:30 BST (= 11:30 UTC): 'next day, later clock time' but only 23.5h elapsed.
    const first = Date.parse("2026-03-28T12:00:00Z");
    const second = Date.parse("2026-03-29T11:30:00Z");
    const s = replaySkill(
      [
        ea({ sessionId: "s1", submittedAt: first, familyId: "A" }),
        ea({ sessionId: "s2", submittedAt: second, familyId: "B", isTransfer: true }),
      ],
      policy,
    );
    expect(second - first).toBeLessThan(MS_DAY);
    expect(s.evidenceState).toBe("demonstrated_once");
    expect(s.stage).toBe(0);
    // Autumn fall-back: 25.0h elapsed across the change qualifies.
    const autumn = replaySkill(
      [
        ea({ sessionId: "s1", submittedAt: Date.parse("2026-10-24T23:30:00Z"), familyId: "A" }),
        ea({ sessionId: "s2", submittedAt: Date.parse("2026-10-26T00:30:00Z"), familyId: "B", isTransfer: true }),
      ],
      policy,
    );
    expect(autumn.evidenceState).toBe("retention_demonstrated");
  });
});
