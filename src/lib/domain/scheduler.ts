// Pure scheduling policy (heuristic-v1) and review queue. No Date.now(): callers pass `now`.
import { MS_DAY, type EvidenceState } from "./types";

export const SCHEDULER_POLICY_ID = "heuristic-v1" as const;
/** Exact intervals in elapsed days, indexed by stage 0..4. */
export const STAGE_INTERVAL_DAYS = [1, 3, 7, 14, 30] as const;
export const MAX_STAGE = STAGE_INTERVAL_DAYS.length - 1;
/** Minimum elapsed time between promotions. Never satisfied by a calendar boundary. */
export const MIN_PROMOTION_GAP_MS = MS_DAY;
/** UX assumption used for budget estimates; configurable. */
export const MINUTES_PER_QUESTION = 5;

export function dueAfterStage(submittedAt: number, stage: number): number {
  const s = Math.max(0, Math.min(MAX_STAGE, stage));
  return submittedAt + STAGE_INTERVAL_DAYS[s] * MS_DAY;
}

export interface ScheduleState {
  stage: number | null;
  dueAt: number | null;
}

/** Learning/supported completed attempt: no stage advance; due = earlier(existing, +1 day). */
export function applySupportedAttempt(state: ScheduleState, submittedAt: number): ScheduleState {
  const candidate = submittedAt + MS_DAY;
  return {
    stage: state.stage,
    dueAt: state.dueAt === null ? candidate : Math.min(state.dueAt, candidate),
  };
}

// ---------------------------------------------------------------- queue

export interface QueueSkillInput {
  skillId: string;
  objective: string;
  topicId: string;
  topicTitle: string;
  topicPosition: number;
  evidenceState: EvidenceState;
  dueAt: number | null;
  reassessmentNeeded: boolean;
  transferRequired: boolean;
  transferCovered: boolean;
  attempted: boolean;
  reviewAvailable: boolean;
}

export type QueueReasonCode =
  | "reassessment_due"
  | "review_due"
  | "missing_independent"
  | "missing_application"
  | "new_learning";

export interface QueueItem {
  skillId: string;
  objective: string;
  reason: QueueReasonCode;
  reasonText: string;
  dueAt: number | null;
  suggestedMode: "learn" | "review";
}

export interface QueueBlock {
  topicId: string;
  topicTitle: string;
  items: QueueItem[];
  estimatedMinutes: number;
  reasons: string[];
}

const REASON_TEXT: Record<QueueReasonCode, string> = {
  reassessment_due: "A recent independent check was missed; another check is due",
  review_due: "Scheduled review is due",
  missing_independent: "Not yet demonstrated without help",
  missing_application: "Still needs a check in a new context",
  new_learning: "Not started yet",
};

function classify(s: QueueSkillInput, now: number): QueueReasonCode | null {
  const due = s.dueAt !== null && s.dueAt <= now;
  if (due && s.reassessmentNeeded) return "reassessment_due";
  if (due) return "review_due";
  if (!s.attempted) return "new_learning";
  if (s.evidenceState === "unassessed" || s.evidenceState === "developing" || s.evidenceState === "supported") {
    // Not due yet: scheduled reviews wait for their date rather than being re-queued early.
    if (s.dueAt !== null && s.dueAt > now) return null;
    return "missing_independent";
  }
  if (s.transferRequired && !s.transferCovered && s.evidenceState === "demonstrated_once") {
    if (s.dueAt !== null && s.dueAt > now) return null;
    return "missing_application";
  }
  return null;
}

const ORDER: QueueReasonCode[] = [
  "reassessment_due",
  "review_due",
  "missing_independent",
  "missing_application",
  "new_learning",
];

/**
 * Build at most `maxBlocks` topic blocks. Order: reassessment due, other due (oldest first),
 * missing independent/application evidence, then optional new learning. Never changes evidence.
 */
export function buildQueue(
  skills: QueueSkillInput[],
  now: number,
  budgetMinutes: number,
  maxBlocks = 3,
  minutesPerQuestion = MINUTES_PER_QUESTION,
): QueueBlock[] {
  const classified = skills
    .map((s) => ({ s, reason: classify(s, now) }))
    .filter((x): x is { s: QueueSkillInput; reason: QueueReasonCode } => x.reason !== null);

  classified.sort((a, b) => {
    const r = ORDER.indexOf(a.reason) - ORDER.indexOf(b.reason);
    if (r !== 0) return r;
    if (a.reason === "review_due" || a.reason === "reassessment_due") {
      return (a.s.dueAt ?? 0) - (b.s.dueAt ?? 0);
    }
    return a.s.topicPosition - b.s.topicPosition || a.s.skillId.localeCompare(b.s.skillId);
  });

  let remaining = Math.max(1, Math.floor(budgetMinutes / minutesPerQuestion));
  const blocks: QueueBlock[] = [];
  for (const { s, reason } of classified) {
    if (remaining <= 0) break;
    let block = blocks.find((b) => b.topicId === s.topicId);
    if (!block) {
      if (blocks.length >= maxBlocks) continue;
      block = { topicId: s.topicId, topicTitle: s.topicTitle, items: [], estimatedMinutes: 0, reasons: [] };
      blocks.push(block);
    }
    const suggestedMode: "learn" | "review" =
      reason !== "new_learning" && s.reviewAvailable ? "review" : "learn";
    block.items.push({
      skillId: s.skillId,
      objective: s.objective,
      reason,
      reasonText: REASON_TEXT[reason],
      dueAt: s.dueAt,
      suggestedMode,
    });
    block.estimatedMinutes += minutesPerQuestion;
    if (!block.reasons.includes(REASON_TEXT[reason])) block.reasons.push(REASON_TEXT[reason]);
    remaining -= 1;
  }
  return blocks;
}
