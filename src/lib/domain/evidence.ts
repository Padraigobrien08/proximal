// Pure evidence reducer. Replays effective attempts in submission (record) order.
import {
  applySupportedAttempt,
  dueAfterStage,
  MAX_STAGE,
  MIN_PROMOTION_GAP_MS,
  SCHEDULER_POLICY_ID,
} from "./scheduler";
import type { EvidenceAttempt, EvidenceState, PassRecord, SkillReviewState } from "./types";

/**
 * qualifiesAsIndependent = review mode AND original checkpoint submission AND no relevant
 * pre-submission exposure AND no declared assistance AND valid, non-excluded assessment.
 * Confidence is deliberately absent.
 */
export function qualifiesAsIndependent(a: EvidenceAttempt): boolean {
  return (
    a.mode === "review" &&
    a.phase === "original" &&
    !a.exposedBeforeSubmission &&
    !a.declaredAssistance &&
    a.validity === "valid" &&
    !a.excluded
  );
}

/** Uncertain, pending, invalid-pending and excluded attempts make no effective update. */
export function isEffective(a: EvidenceAttempt): boolean {
  return a.outcome !== null && a.outcome !== "uncertain" && !a.excluded && a.validity === "valid";
}

export interface SkillPolicy {
  transferRequired: boolean;
}

/** Two independent passes in different sessions, >=24h apart, distinct families, transfer covered if required. */
export function hasRetention(passes: PassRecord[], policy: SkillPolicy): boolean {
  for (let i = 0; i < passes.length; i++) {
    for (let j = i + 1; j < passes.length; j++) {
      const a = passes[i];
      const b = passes[j];
      if (a.sessionId === b.sessionId) continue;
      if (Math.abs(b.submittedAt - a.submittedAt) < MIN_PROMOTION_GAP_MS) continue;
      if (a.familyId === b.familyId) continue;
      if (policy.transferRequired && !a.isTransfer && !b.isTransfer) continue;
      return true;
    }
  }
  return false;
}

export function initialReviewState(): SkillReviewState {
  return {
    evidenceState: "unassessed",
    epoch: 0,
    stage: null,
    dueAt: null,
    lastPassAt: null,
    reassessmentNeeded: false,
    currentEpochPasses: [],
    transferCovered: false,
    lastIndependentAt: null,
    lastIndependentOutcome: null,
    policyId: SCHEDULER_POLICY_ID,
  };
}

export function replaySkill(attempts: EvidenceAttempt[], policy: SkillPolicy): SkillReviewState {
  const ordered = [...attempts].sort((a, b) => a.recordOrder - b.recordOrder);

  let epoch = 0;
  let stage: number | null = null;
  let dueAt: number | null = null;
  let lastPassAt: number | null = null;
  let reassessmentNeeded = false;
  let passes: PassRecord[] = [];
  let lastPromotionAt: number | null = null;
  const promotedSessions = new Set<string>();
  let lastIndependentAt: number | null = null;
  let lastIndependentOutcome: SkillReviewState["lastIndependentOutcome"] = null;
  // Per-epoch facts for the evidence label.
  let epochSupportedPass = false;
  let epochAnyAttempt = false;

  for (const a of ordered) {
    if (!isEffective(a)) continue;
    const outcome = a.outcome!;

    if (qualifiesAsIndependent(a)) {
      lastIndependentAt = a.submittedAt;
      lastIndependentOutcome = outcome;
      if (outcome === "pass") {
        if (passes.length === 0) {
          // First independent pass in an epoch.
          stage = 0;
          dueAt = dueAfterStage(a.submittedAt, 0);
          lastPromotionAt = a.submittedAt;
          promotedSessions.add(a.sessionId);
        } else if (
          !promotedSessions.has(a.sessionId) &&
          lastPromotionAt !== null &&
          a.submittedAt - lastPromotionAt >= MIN_PROMOTION_GAP_MS
        ) {
          stage = Math.min((stage ?? 0) + 1, MAX_STAGE);
          dueAt = dueAfterStage(a.submittedAt, stage);
          lastPromotionAt = a.submittedAt;
          promotedSessions.add(a.sessionId);
        }
        // Same-session or <24h additional pass: keep stage/due; retained for coverage/history.
        passes.push({
          attemptId: a.attemptId,
          sessionId: a.sessionId,
          submittedAt: a.submittedAt,
          familyId: a.familyId,
          isTransfer: a.isTransfer,
        });
        lastPassAt = a.submittedAt;
        reassessmentNeeded = false;
        epochAnyAttempt = true;
      } else {
        // Valid independent partial/fail: new epoch, retention gate resets.
        epoch += 1;
        passes = [];
        stage = 0;
        dueAt = dueAfterStage(a.submittedAt, 0);
        reassessmentNeeded = true;
        epochSupportedPass = false;
        epochAnyAttempt = true;
        // promotedSessions is kept: a lapse never grants an extra promotion in the same session.
        lastPromotionAt = null;
      }
    } else {
      // Learning / supported attempt: never starts an epoch or erases independent evidence.
      const next = applySupportedAttempt({ stage, dueAt }, a.submittedAt);
      stage = next.stage;
      dueAt = next.dueAt;
      epochAnyAttempt = true;
      if (outcome === "pass") epochSupportedPass = true;
    }
  }

  let evidenceState: EvidenceState;
  if (hasRetention(passes, policy)) evidenceState = "retention_demonstrated";
  else if (passes.length > 0) evidenceState = "demonstrated_once";
  else if (epochSupportedPass) evidenceState = "supported";
  else if (epochAnyAttempt) evidenceState = "developing";
  else evidenceState = "unassessed";

  return {
    evidenceState,
    epoch,
    stage,
    dueAt,
    lastPassAt,
    reassessmentNeeded,
    currentEpochPasses: passes,
    transferCovered: passes.some((p) => p.isTransfer),
    lastIndependentAt,
    lastIndependentOutcome,
    policyId: SCHEDULER_POLICY_ID,
  };
}
