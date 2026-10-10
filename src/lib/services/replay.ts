// Historical replay: a seeded example (fixed dates) run through the real pure reducers.
// Kept outside the learner database so it can never be mistaken for participant data.
import { loadFixtures } from "../content/fixtures";
import { replaySkill } from "../domain/evidence";
import { EVIDENCE_LABELS, formatDateTime } from "../domain/labels";
import { MS_DAY, MS_HOUR, type EvidenceAttempt } from "../domain/types";
import type { AppContext } from "./context";

export function buildHistoricalReplay(ctx: Pick<AppContext, "timezone">) {
  const { replay, bank, curriculum } = loadFixtures();
  const start = Date.parse(replay.startAt);
  const startDay = start - (start % MS_DAY);
  const skills = new Map(curriculum.topics.flatMap((t) => t.units.flatMap((u) => u.skills)).map((s) => [s.id, s]));

  const attempts: (EvidenceAttempt & { skillId: string; questionId: string; note: string })[] = replay.events.map((e, i) => {
    const q = bank.questions.find((x) => x.id === e.questionId);
    if (!q) throw new Error(`Replay references unknown question ${e.questionId}`);
    return {
      attemptId: `replay-${i}`,
      sessionId: e.sessionKey,
      submittedAt: startDay + e.day * MS_DAY + e.hour * MS_HOUR + i * 60_000,
      recordOrder: i + 1,
      mode: e.mode,
      phase: e.phase,
      exposedBeforeSubmission: e.exposedBeforeSubmission,
      declaredAssistance: false,
      outcome: e.outcome,
      validity: "valid",
      excluded: false,
      familyId: q.familyId,
      isTransfer: q.isTransfer,
      skillId: q.skillId,
      questionId: q.id,
      note: e.note,
    };
  });

  const timeline = attempts.map((a, i) => {
    const soFar = attempts.slice(0, i + 1).filter((x) => x.skillId === a.skillId);
    const state = replaySkill(soFar, { transferRequired: skills.get(a.skillId)?.transferRequired ?? true });
    return {
      at: formatDateTime(a.submittedAt, ctx.timezone),
      day: Math.floor((a.submittedAt - startDay) / MS_DAY),
      questionId: a.questionId,
      skillId: a.skillId,
      skillObjective: skills.get(a.skillId)?.objective ?? a.skillId,
      phase: a.phase,
      mode: a.mode,
      outcome: a.outcome,
      note: a.note,
      evidenceLabel: EVIDENCE_LABELS[state.evidenceState].label,
      stage: state.stage,
      due: state.dueAt !== null ? formatDateTime(state.dueAt, ctx.timezone) : null,
      reassessmentNeeded: state.reassessmentNeeded,
    };
  });

  return { label: replay.label, description: replay.description, timeline };
}
