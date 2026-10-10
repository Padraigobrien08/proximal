// Rebuild cached review_states from ordered accepted attempts and their frozen exposure snapshots.
import { replaySkill } from "../domain/evidence";
import type { SkillReviewState } from "../domain/types";
import { evidenceAttemptsForSkill, getReviewState, getSkill, upsertReviewState } from "../db/repo";
import type { AppContext } from "./context";
import { notFound } from "./errors";

export function rebuildSkillState(ctx: Pick<AppContext, "db" | "clock">, skillId: string): SkillReviewState {
  const skill = getSkill(ctx.db, skillId);
  if (!skill) throw notFound("Skill");
  const state = replaySkill(evidenceAttemptsForSkill(ctx.db, skillId), { transferRequired: skill.transferRequired });
  upsertReviewState(ctx.db, skillId, skill.version, state, ctx.clock.now());
  return state;
}

export function currentSkillState(ctx: Pick<AppContext, "db" | "clock">, skillId: string): SkillReviewState {
  const skill = getSkill(ctx.db, skillId);
  if (!skill) throw notFound("Skill");
  return getReviewState(ctx.db, skillId, skill.version) ?? rebuildSkillState(ctx, skillId);
}

/** Sessions whose checkpoint is still open: their judgements must not surface anywhere before release. */
export function openCheckpointSessionIds(ctx: Pick<AppContext, "db">): Set<string> {
  const rows = ctx.db.prepare("SELECT id FROM sessions WHERE status = 'active' AND mode = 'review' AND phase = 'checkpoint'").all() as {
    id: string;
  }[];
  return new Set(rows.map((r) => r.id));
}

/**
 * Learner-facing skill state. Identical to the stored state except that attempts from a checkpoint that is still
 * in progress are left out, so the home, topic and course screens cannot reveal a result before release.
 */
export function displaySkillState(
  ctx: Pick<AppContext, "db" | "clock">,
  skillId: string,
  hidden: Set<string> = openCheckpointSessionIds(ctx),
): SkillReviewState {
  const skill = getSkill(ctx.db, skillId);
  if (!skill) throw notFound("Skill");
  const attempts = evidenceAttemptsForSkill(ctx.db, skillId);
  if (!attempts.some((a) => hidden.has(a.sessionId))) return currentSkillState(ctx, skillId);
  return replaySkill(
    attempts.filter((a) => !hidden.has(a.sessionId)),
    { transferRequired: skill.transferRequired },
  );
}
