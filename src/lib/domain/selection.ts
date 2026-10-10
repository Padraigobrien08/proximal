// Reviewed question selection. Pure.
import type { QuestionStatus } from "./types";

export interface SelectableQuestion {
  id: string;
  skillId: string;
  familyId: string;
  isTransfer: boolean;
  status: QuestionStatus;
}

export interface SelectionResult {
  questionId: string;
  familyId: string;
  /** Only previously used families remain: practice allowed, not new-context coverage. */
  repeatedFamily: boolean;
}

/**
 * Independent checks and new learning: prefer never-attempted question families, then the least recently attempted family.
 * Ties: initial (non-transfer) families before transfer families, then by id.
 * Excluded questions are never selected.
 */
export function selectQuestion(
  questions: SelectableQuestion[],
  lastAttemptedAtByFamily: Map<string, number>,
  purpose: "check" | "practice" = "check",
): SelectionResult | null {
  const eligible = questions.filter((q) => q.status !== "excluded");
  if (eligible.length === 0) return null;
  if (purpose === "practice") {
    // Targeted practice reuses the most recently attempted family so fresh families stay
    // available for later independent checks; with no history it starts from the initial family.
    const practised = [...eligible]
      .filter((q) => lastAttemptedAtByFamily.has(q.familyId))
      .sort((a, b) => lastAttemptedAtByFamily.get(b.familyId)! - lastAttemptedAtByFamily.get(a.familyId)! || a.id.localeCompare(b.id))[0];
    if (practised) return { questionId: practised.id, familyId: practised.familyId, repeatedFamily: true };
  }
  const sorted = [...eligible].sort((a, b) => {
    const la = lastAttemptedAtByFamily.get(a.familyId);
    const lb = lastAttemptedAtByFamily.get(b.familyId);
    if (la === undefined && lb !== undefined) return -1;
    if (lb === undefined && la !== undefined) return 1;
    if (la !== undefined && lb !== undefined && la !== lb) return la - lb;
    if (a.isTransfer !== b.isTransfer) return a.isTransfer ? 1 : -1;
    return a.id.localeCompare(b.id);
  });
  const chosen = sorted[0];
  return {
    questionId: chosen.id,
    familyId: chosen.familyId,
    repeatedFamily: lastAttemptedAtByFamily.has(chosen.familyId),
  };
}
