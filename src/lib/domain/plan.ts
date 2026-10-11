// Pure study-plan builder: recommendation, up to three tasks, and the next scheduled check.
// Computed from persisted evidence/schedules/sessions only; never asks a model what to recommend.
import { MINUTES_PER_QUESTION } from "./scheduler";
import type { EvidenceState, TaskType } from "./types";

export type ActionKind = "learn" | "practice" | "check" | "review" | "resume" | "view";

/** Learner-facing step names. A review of skills never yet right without help is shown as a quick check. */
export const STEP_LABEL: Record<ActionKind, string> = {
  learn: "Learn",
  practice: "Practice",
  check: "Quick check",
  review: "Review",
  resume: "Continue",
  view: "Topic",
};

export interface StudyTask {
  /** Stable recommendation identity (not a learning event). */
  id: string;
  courseId: string;
  topicId: string;
  topicTitle: string;
  skillIds: string[];
  /** Full objectives of the targeted skills (topic page keeps the detail). */
  objectives: string[];
  /** Compact noun phrase for plan rows, e.g. "Notation and dataset likelihood". */
  focus: string;
  /** One short sentence for the recommendation, e.g. "Explain what BCE penalises, then calculate and compare losses." */
  summary: string;
  action: ActionKind;
  title: string;
  reason: string;
  estimatedMinutes: number;
  dueAt: number | null;
  sessionId: string | null;
}

export interface PlanSkill {
  skillId: string;
  objective: string;
  /** Short noun phrase; falls back to the objective. */
  label?: string | null;
  /** Short verb phrase; falls back to the objective. */
  summary?: string | null;
  primaryTaskType: TaskType | null;
  courseId: string;
  topicId: string;
  topicTitle: string;
  /** Global ordering key: course position, topic position, skill position. */
  order: number;
  required: boolean;
  evidenceState: EvidenceState;
  dueAt: number | null;
  reassessmentNeeded: boolean;
  attempted: boolean;
  /** A published, non-excluded question exists for an independent check. */
  reviewAvailable: boolean;
  /** Something to learn from: a practice question or an explanation source. */
  learnAvailable: boolean;
}

export interface PlanSession {
  sessionId: string;
  courseId: string;
  topicId: string;
  topicTitle: string;
  mode: "learn" | "review";
  purpose: "learn" | "practice" | "check" | "review";
  phase: "checkpoint" | "results" | "repair" | "learning";
  lastActivityAt: number;
  answered: number;
  total: number;
  /** Original answers without a final assessment. */
  pendingAssessments: number;
  providerErrors: number;
  feedbackReleased: boolean;
  /** Skills whose original answer did not pass and that have no passing correction yet. */
  unresolvedRepairSkillIds: string[];
  skillIds: string[];
  /** Learn sessions: practice questions not yet reached. */
  remainingQuestions: number;
}

export interface PlanInput {
  now: number;
  budgetMinutes: number;
  skills: PlanSkill[];
  activeSessions: PlanSession[];
  minutesPerQuestion?: number;
  maxTasks?: number;
}

export interface NextCheck {
  topicId: string;
  topicTitle: string;
  skillIds: string[];
  objectives: string[];
  /** "calculation", "explanation" ... or "topic" when several task types are due together. */
  noun: string;
  focus: string;
  dueAt: number;
}

export interface StudyPlan {
  recommendation: StudyTask | null;
  plan: StudyTask[];
  nextScheduledCheck: NextCheck | null;
  /** True when nothing is actionable now (only future checks or nothing at all). */
  upToDate: boolean;
  totalMinutes: number;
}

/** Noun used in titles for a skill's primary task type ("the calculation practice"). */
export function taskNoun(t: TaskType | null): string {
  switch (t) {
    case "calculate":
      return "calculation";
    case "apply":
      return "application";
    case "derive":
      return "derivation";
    case "explain":
      return "explanation";
    default:
      return "skill";
  }
}

/** Lower-case the first letter unless it starts an acronym ("BCE meaning" stays). */
export function lowerFirst(s: string): string {
  return s.length > 1 && s[1] === s[1].toLowerCase() ? s[0].toLowerCase() + s.slice(1) : s;
}

function joinPhrases(parts: string[], last: string): string {
  const [first, ...rest] = parts;
  if (!first) return "";
  const tail = rest.map(lowerFirst);
  if (tail.length === 0) return first;
  return `${[first, ...tail.slice(0, -1)].join(", ")}${last}${tail[tail.length - 1]}`;
}

/** "Notation and dataset likelihood" */
export function focusOf(skills: Pick<PlanSkill, "label" | "objective">[]): string {
  return joinPhrases(
    skills.map((s) => s.label || s.objective),
    " and ",
  );
}

/** "Explain what BCE penalises, then calculate and compare losses." */
export function summaryOf(skills: Pick<PlanSkill, "summary" | "objective">[]): string {
  const text = joinPhrases(
    skills.map((s) => s.summary || s.objective),
    ", then ",
  );
  return text ? `${text.replace(/\.$/, "")}.` : "";
}

/** An unfinished session should be resumed rather than duplicated. */
export function isUnfinished(s: PlanSession): boolean {
  if (s.mode === "learn") return s.remainingQuestions > 0;
  if (s.phase === "checkpoint" || s.phase === "results") return true;
  if (s.phase === "repair") return s.unresolvedRepairSkillIds.length > 0;
  return false;
}

function resumeTask(s: PlanSession, skills: Map<string, PlanSkill>, mpq: number): StudyTask {
  let title: string;
  let reason: string;
  let minutes = mpq;
  if (s.mode === "learn") {
    title = "Continue learning";
    reason = `${s.remainingQuestions} practice question${s.remainingQuestions === 1 ? "" : "s"} left`;
    minutes = s.remainingQuestions * mpq;
  } else if (s.phase === "checkpoint") {
    title = s.purpose === "review" ? "Continue your review" : "Continue your quick check";
    reason = `${s.answered} of ${s.total} answers saved`;
    minutes = Math.max(1, s.total - s.answered) * mpq;
  } else if (s.phase === "results" && s.providerErrors > 0) {
    title = "Your answer is saved";
    reason = "Assessment needs another attempt";
  } else if (s.phase === "results" && s.pendingAssessments > 0) {
    title = "Your answer is saved";
    reason = "Assessment in progress";
  } else if (s.phase === "results") {
    title = "Your results are ready";
    reason = "Feedback has not been opened yet";
  } else {
    const first = skills.get(s.unresolvedRepairSkillIds[0]);
    title = `Continue the ${taskNoun(first?.primaryTaskType ?? null)} practice`;
    reason = "Your original answer is saved";
  }
  const targeted = (s.phase === "repair" ? s.unresolvedRepairSkillIds : s.skillIds)
    .map((id) => skills.get(id))
    .filter((x): x is PlanSkill => !!x);
  return {
    id: `resume:${s.sessionId}`,
    focus: focusOf(targeted),
    summary: summaryOf(targeted),
    courseId: s.courseId,
    topicId: s.topicId,
    topicTitle: s.topicTitle,
    skillIds: s.phase === "repair" ? s.unresolvedRepairSkillIds : s.skillIds,
    objectives: (s.phase === "repair" ? s.unresolvedRepairSkillIds : s.skillIds).map((id) => skills.get(id)?.objective ?? id),
    action: "resume",
    title,
    reason,
    estimatedMinutes: minutes,
    dueAt: null,
    sessionId: s.sessionId,
  };
}

type Tier = "reassess" | "due" | "gap" | "new";

function tierOf(s: PlanSkill, now: number): Tier | null {
  const due = s.dueAt !== null && s.dueAt <= now;
  if (due && s.reviewAvailable && s.reassessmentNeeded) return "reassess";
  if (due && s.reviewAvailable) return "due";
  if (s.evidenceState === "developing" && !due && s.learnAvailable) return "gap";
  if (
    s.required &&
    s.learnAvailable &&
    s.evidenceState === "unassessed"
  ) {
    return "new";
  }
  return null;
}

const TIER_ORDER: Tier[] = ["reassess", "due", "gap", "new"];

function taskFor(tier: Tier, group: PlanSkill[], topicAttempted: boolean, now: number, mpq: number): StudyTask {
  const first = group[0];
  const minDue = Math.min(...group.map((g) => g.dueAt ?? Infinity));
  const base = {
    courseId: first.courseId,
    topicId: first.topicId,
    topicTitle: first.topicTitle,
    skillIds: group.map((g) => g.skillId),
    objectives: group.map((g) => g.objective),
    focus: focusOf(group),
    summary: summaryOf(group),
    estimatedMinutes: group.length * mpq,
    sessionId: null,
  };
  const noun = group.length === 1 ? taskNoun(first.primaryTaskType) : "topic";
  switch (tier) {
    case "reassess":
      return {
        ...base,
        id: `review:${first.topicId}:${base.skillIds.join(",")}`,
        action: "review",
        title: `Fresh ${noun === "topic" ? "" : `${noun} `}check due`,
        reason: `${capitalise(noun)} needs another check`,
        dueAt: Number.isFinite(minDue) ? minDue : null,
      };
    case "due":
      return {
        ...base,
        id: `review:${first.topicId}:${base.skillIds.join(",")}`,
        action: "review",
        title: "Scheduled review due",
        reason: `Scheduled ${noun === "topic" ? "" : `${noun} `}check is due`,
        dueAt: Number.isFinite(minDue) ? minDue : null,
      };
    case "gap":
      return {
        ...base,
        id: `practice:${first.topicId}:${base.skillIds.join(",")}`,
        action: "practice",
        title: noun === "topic" ? "Practise the gaps" : `Practise the ${noun}`,
        reason: `Your last ${noun === "topic" ? "answers need" : `${noun} needs`} another step`,
        dueAt: null,
      };
    case "new":
      return {
        ...base,
        id: `learn:${first.topicId}:${base.skillIds.join(",")}`,
        action: "learn",
        title: topicAttempted ? "Continue learning" : "Start learning",
        reason: "Not studied yet",
        dueAt: null,
      };
  }
  void now;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Priority: resume the most recent unfinished session; due skills needing reassessment; other due skills
 * (oldest first); unresolved gaps with practice available; required skills not yet studied. Future checks
 * are reported separately and never counted as due. Tasks are packed into the time budget (~5 min/question)
 * without skipping a higher-priority task to fit lower-priority work; an oversize first task is trimmed to
 * its minimum meaningful segment (one question).
 */
export function buildStudyPlan(input: PlanInput): StudyPlan {
  const mpq = input.minutesPerQuestion ?? MINUTES_PER_QUESTION;
  const maxTasks = input.maxTasks ?? 3;
  const { now } = input;
  const skills = new Map(input.skills.map((s) => [s.skillId, s]));
  const tasks: StudyTask[] = [];
  const claimed = new Set<string>();

  const resumable = input.activeSessions
    .filter(isUnfinished)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.sessionId.localeCompare(b.sessionId))[0];
  if (resumable) {
    const t = resumeTask(resumable, skills, mpq);
    tasks.push(t);
    for (const id of resumable.skillIds) claimed.add(id);
  }

  const byTier = new Map<Tier, PlanSkill[]>();
  for (const s of input.skills) {
    if (claimed.has(s.skillId)) continue;
    const tier = tierOf(s, now);
    if (!tier) continue;
    byTier.set(tier, [...(byTier.get(tier) ?? []), s]);
  }
  const topicAttempted = new Set(input.skills.filter((s) => s.attempted).map((s) => s.topicId));

  const candidates: StudyTask[] = [];
  for (const tier of TIER_ORDER) {
    const list = [...(byTier.get(tier) ?? [])].sort((a, b) =>
      tier === "reassess" || tier === "due"
        ? (a.dueAt ?? 0) - (b.dueAt ?? 0) || a.order - b.order || a.skillId.localeCompare(b.skillId)
        : a.order - b.order || a.skillId.localeCompare(b.skillId),
    );
    // Group by topic within the tier, keeping first-appearance order.
    const groups = new Map<string, PlanSkill[]>();
    for (const s of list) groups.set(s.topicId, [...(groups.get(s.topicId) ?? []), s]);
    for (const group of groups.values()) candidates.push(taskFor(tier, group, topicAttempted.has(group[0].topicId), now, mpq));
  }

  // Pack into the budget in priority order.
  let remaining = input.budgetMinutes - tasks.reduce((n, t) => n + t.estimatedMinutes, 0);
  for (const c of candidates) {
    if (tasks.length >= maxTasks) break;
    if (c.estimatedMinutes <= remaining) {
      tasks.push(c);
      remaining -= c.estimatedMinutes;
      continue;
    }
    const fit = Math.floor(remaining / mpq);
    if (tasks.length === 0 || fit >= 1) {
      // Minimum meaningful segment: as many questions as fit (at least one for the first task).
      const n = Math.max(1, Math.min(fit, c.skillIds.length));
      tasks.push({
        ...c,
        id: `${c.id}#${n}`,
        skillIds: c.skillIds.slice(0, n),
        objectives: c.objectives.slice(0, n),
        focus: focusOf(c.skillIds.slice(0, n).map((id) => skills.get(id)!)),
        summary: summaryOf(c.skillIds.slice(0, n).map((id) => skills.get(id)!)),
        estimatedMinutes: n * mpq,
      });
      remaining -= n * mpq;
    }
    // Never skip this task to fill the budget with lower-priority work.
    break;
  }

  // Next scheduled check: earliest future due date, grouped with same-topic skills due within a day of it.
  const future = input.skills
    .filter((s) => s.dueAt !== null && s.dueAt > now && s.reviewAvailable)
    .sort((a, b) => a.dueAt! - b.dueAt! || a.order - b.order);
  let nextScheduledCheck: NextCheck | null = null;
  if (future.length > 0) {
    const first = future[0];
    const same = future.filter((s) => s.topicId === first.topicId && s.dueAt! - first.dueAt! < 24 * 60 * 60 * 1000);
    const nouns = [...new Set(same.map((s) => taskNoun(s.primaryTaskType)))];
    nextScheduledCheck = {
      topicId: first.topicId,
      topicTitle: first.topicTitle,
      skillIds: same.map((s) => s.skillId),
      objectives: same.map((s) => s.objective),
      noun: nouns.length === 1 ? nouns[0] : "topic",
      focus: focusOf(same),
      dueAt: first.dueAt!,
    };
  }

  const upToDate = tasks.length === 0;
  let recommendation: StudyTask | null = tasks[0] ?? null;
  const unavailable = input.skills
    .filter((s) => s.required && s.evidenceState === "unassessed" && !s.learnAvailable && !s.reviewAvailable)
    .sort((a, b) => a.order - b.order)[0];
  if (!recommendation && !nextScheduledCheck && unavailable) {
    recommendation = {
      id: `view:${unavailable.topicId}:unavailable`,
      courseId: unavailable.courseId,
      topicId: unavailable.topicId,
      topicTitle: unavailable.topicTitle,
      skillIds: [unavailable.skillId],
      objectives: [unavailable.objective],
      focus: focusOf([unavailable]),
      summary: summaryOf([unavailable]),
      action: "view",
      title: "Reviewed questions needed",
      reason: `${unavailable.topicTitle} has no reviewed questions yet; its source material is still available`,
      estimatedMinutes: 0,
      dueAt: null,
      sessionId: null,
    };
  }
  if (!recommendation && nextScheduledCheck) {
    const s = skills.get(nextScheduledCheck.skillIds[0])!;
    recommendation = {
      id: `view:${nextScheduledCheck.topicId}`,
      courseId: s.courseId,
      topicId: nextScheduledCheck.topicId,
      topicTitle: nextScheduledCheck.topicTitle,
      skillIds: nextScheduledCheck.skillIds,
      objectives: nextScheduledCheck.objectives,
      focus: nextScheduledCheck.focus,
      summary: `A fresh ${nextScheduledCheck.noun === "topic" ? "" : `${nextScheduledCheck.noun} `}check is scheduled.`,
      action: "view",
      title: "Your next check is scheduled",
      reason: "",
      estimatedMinutes: 0,
      dueAt: nextScheduledCheck.dueAt,
      sessionId: null,
    };
  }
  return {
    recommendation,
    plan: tasks,
    nextScheduledCheck,
    upToDate,
    totalMinutes: tasks.reduce((n, t) => n + t.estimatedMinutes, 0),
  };
}
