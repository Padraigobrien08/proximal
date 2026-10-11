// Read model for mastery levels: subtopic (unit) levels and their topic/module rollups. Public data only.
import { CHECKED, levelOf, rollup, subtopicLevel, type Level, type LevelRollup } from "../domain/levels";
import { relativeWhen } from "../domain/labels";
import { listQuestionsForSkill, listSkillsForUnit, listTopics, listUnits } from "../db/repo";
import type { AppContext } from "./context";
import { displaySkillState, openCheckpointSessionIds } from "./evidence";

export interface SubtopicMastery {
  id: string;
  title: string;
  objective: string;
  sourcePages: number[];
  level: Level;
  due: boolean;
  skillIds: string[];
  lastIndependentAt: number | null;
  /** Plain status line, e.g. "Last no-help check yesterday at 10:00". */
  lastLabel: string | null;
  /** What happens next for this subtopic, e.g. "Review due" or "No-help check tomorrow at 09:00". */
  nextLabel: string;
  reviewAvailable: boolean;
}

export interface TopicMastery {
  id: string;
  title: string;
  rollup: LevelRollup;
  subtopics: SubtopicMastery[];
}

export interface ModuleMastery {
  rollup: LevelRollup;
  topics: TopicMastery[];
}

export function topicSubtopics(ctx: AppContext, topicId: string, hidden: Set<string> = openCheckpointSessionIds(ctx)): SubtopicMastery[] {
  const now = ctx.clock.now();
  return listUnits(ctx.db, topicId)
    .map((u) => {
      const skills = listSkillsForUnit(ctx.db, u.id).map((s) => {
        const st = displaySkillState(ctx, s.id, hidden);
        const reviewAvailable = listQuestionsForSkill(ctx.db, s.id).some((q) => q.status !== "excluded");
        return { id: s.id, required: s.required, state: st, evidenceState: st.evidenceState, reviewAvailable };
      });
      if (skills.length === 0) return null;
      const level = subtopicLevel(skills);
      const reviewAvailable = skills.some((s) => s.reviewAvailable);
      const due = skills.some((s) => s.reviewAvailable && s.state.dueAt !== null && s.state.dueAt <= now);
      const dueTimes = skills.map((s) => s.state.dueAt).filter((d): d is number => d !== null);
      const nextDue = dueTimes.length ? Math.min(...dueTimes) : null;
      const lastTimes = skills.map((s) => s.state.lastIndependentAt).filter((d): d is number => d !== null);
      const lastIndependentAt = lastTimes.length ? Math.max(...lastTimes) : null;
      const reassess = skills.some((s) => s.state.reassessmentNeeded);
      return {
        id: u.id,
        title: u.title,
        objective: u.objective,
        sourcePages: u.sourceRefs.map((r) => r.page),
        level,
        due,
        skillIds: skills.map((s) => s.id),
        lastIndependentAt,
        lastLabel:
          lastIndependentAt === null
            ? null
            : `Last no-help check ${relativeWhen(lastIndependentAt, now, ctx.timezone)}`,
        nextLabel: nextLabel({ level, due, reassess, nextDue, reviewAvailable, now, timezone: ctx.timezone }),
        reviewAvailable,
      } satisfies SubtopicMastery;
    })
    .filter((x): x is SubtopicMastery => x !== null);
}

function nextLabel(o: { level: Level; due: boolean; reassess: boolean; nextDue: number | null; reviewAvailable: boolean; now: number; timezone: string }): string {
  if (!o.reviewAvailable && o.level === 0) return "Reviewed questions needed before a check";
  if (o.due) return o.level >= CHECKED || o.reassess ? "Review due" : "Ready for a no-help check";
  const when = o.nextDue !== null ? relativeWhen(o.nextDue, o.now, o.timezone) : null;
  switch (o.level) {
    case 0:
      return "New";
    case 1:
      return when ? `Another check ${when}` : "Continue learning";
    case 2:
      return when ? `No-help check ${when}` : "Ready for a no-help check";
    default:
      return when ? `Next review ${when}` : "No review scheduled";
  }
}

export function topicMastery(ctx: AppContext, topic: { id: string; title: string }, hidden?: Set<string>): TopicMastery {
  const subtopics = topicSubtopics(ctx, topic.id, hidden);
  return { id: topic.id, title: topic.title, rollup: rollup(subtopics), subtopics };
}

export function moduleMastery(ctx: AppContext, courseId: string, hidden: Set<string> = openCheckpointSessionIds(ctx)): ModuleMastery {
  const topics = listTopics(ctx.db, courseId).map((t) => topicMastery(ctx, t, hidden));
  return { rollup: rollup(topics.flatMap((t) => t.subtopics)), topics };
}

/** Current level for each given unit (used to report changes after a study run). */
export function unitLevels(ctx: AppContext, unitIds: string[]): Record<string, Level> {
  const hidden = openCheckpointSessionIds(ctx);
  const out: Record<string, Level> = {};
  for (const unitId of unitIds) {
    const skills = listSkillsForUnit(ctx.db, unitId).map((s) => ({ required: s.required, evidenceState: displaySkillState(ctx, s.id, hidden).evidenceState }));
    out[unitId] = skills.length ? subtopicLevel(skills) : levelOf("unassessed");
  }
  return out;
}
