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
