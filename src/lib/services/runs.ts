// Study runs: one press of Continue. The current study plan is frozen into ordered steps, and each step runs as an
// ordinary session, so checkpoint, assistance and evidence rules are exactly those of single sessions.
import { CHECKED, LEVELS, type Level } from "../domain/levels";
import { relativeWhen } from "../domain/labels";
import { isUnfinished, STEP_LABEL, type ActionKind, type StudyTask } from "../domain/plan";
import { getSession, getSkill, getTopic, getUnit, newId } from "../db/repo";
import type { AppContext } from "./context";
import { AppError, notFound } from "./errors";
import { unitLevels } from "./mastery";
import { endSession, startSession, summariseSession } from "./sessions";
import { planFor, type PlanScope } from "./views";

interface RunRow {
  id: string;
  scopeCourseId: string | null;
  scopeTopicId: string | null;
  budgetMinutes: number;
  status: "active" | "ended";
  currentPosition: number;
  startLevels: Record<string, Level>;
  createdAt: number;
}

interface StepRow {
  position: number;
  task: StudyTask;
  sessionId: string | null;
  outcome: "started" | "done" | "left" | "skipped" | null;
}

function getRun(ctx: AppContext, runId: string): RunRow | null {
  const r = ctx.db.prepare("SELECT * FROM study_runs WHERE id = ?").get(runId) as
    | {
        id: string;
        scope_course_id: string | null;
        scope_topic_id: string | null;
        budget_minutes: number;
        status: "active" | "ended";
        current_position: number;
        start_levels_json: string;
        created_at: number;
      }
    | undefined;
  if (!r) return null;
  return {
    id: r.id,
    scopeCourseId: r.scope_course_id,
    scopeTopicId: r.scope_topic_id,
    budgetMinutes: r.budget_minutes,
    status: r.status,
    currentPosition: r.current_position,
    startLevels: JSON.parse(r.start_levels_json) as Record<string, Level>,
    createdAt: r.created_at,
  };
}

function listSteps(ctx: AppContext, runId: string): StepRow[] {
  const rows = ctx.db
    .prepare("SELECT position, task_json, session_id, outcome FROM study_run_steps WHERE run_id = ? ORDER BY position")
    .all(runId) as { position: number; task_json: string; session_id: string | null; outcome: StepRow["outcome"] }[];
  return rows.map((r) => ({ position: r.position, task: JSON.parse(r.task_json) as StudyTask, sessionId: r.session_id, outcome: r.outcome }));
}

function requireRun(ctx: AppContext, runId: string): RunRow {
  const run = getRun(ctx, runId);
  if (!run) throw notFound("Study session");
  return run;
}

function endRunRow(ctx: AppContext, runId: string) {
  ctx.db.prepare("UPDATE study_runs SET status = 'ended', ended_at = ? WHERE id = ? AND status = 'active'").run(ctx.clock.now(), runId);
}

function unitIdsForTask(ctx: AppContext, task: StudyTask): string[] {
  return [...new Set(task.skillIds.map((id) => getSkill(ctx.db, id)?.unitId).filter((x): x is string => !!x))];
}

// ---------------------------------------------------------------- start / advance

export interface StartRunInput extends PlanScope {
  budgetMinutes: number;
}

export interface RunPosition {
  runId: string;
  /** Session for the current step; null when the run is over. */
  sessionId: string | null;
  done: boolean;
}

export function startRun(ctx: AppContext, input: StartRunInput): RunPosition {
  if (input.topicId && !getTopic(ctx.db, input.topicId)) throw notFound("Topic");
  const plan = planFor(ctx, input.budgetMinutes, { courseId: input.courseId, topicId: input.topicId });
  const tasks = plan.plan.filter((t) => t.action !== "view");
  if (tasks.length === 0) {
    throw new AppError("conflict", "You're up to date: nothing is due and nothing new is ready to study here.");
  }
  const unitIds = [...new Set(tasks.flatMap((t) => unitIdsForTask(ctx, t)))];
  const runId = newId();
  ctx.db.transaction(() => {
    // One Continue at a time: an older run stops where it was. Its sessions keep every saved answer.
    ctx.db.prepare("UPDATE study_runs SET status = 'ended', ended_at = ? WHERE status = 'active'").run(ctx.clock.now());
    ctx.db
      .prepare(
        "INSERT INTO study_runs (id, scope_course_id, scope_topic_id, budget_minutes, status, current_position, start_levels_json, created_at) VALUES (?, ?, ?, ?, 'active', 0, ?, ?)",
      )
      .run(runId, input.courseId ?? null, input.topicId ?? null, input.budgetMinutes, JSON.stringify(unitLevels(ctx, unitIds)), ctx.clock.now());
    const insert = ctx.db.prepare("INSERT INTO study_run_steps (run_id, position, task_json) VALUES (?, ?, ?)");
    tasks.forEach((t, i) => insert.run(runId, i, JSON.stringify(t)));
  })();
  const sessionId = openStepFrom(ctx, runId, 0);
  return { runId, sessionId, done: sessionId === null };
}

/** Start the session for the first step at or after `position` that can run; steps that cannot start are skipped. */
function openStepFrom(ctx: AppContext, runId: string, position: number): string | null {
  for (const step of listSteps(ctx, runId).filter((s) => s.position >= position)) {
    let sessionId: string | null = null;
    try {
      sessionId =
        step.task.action === "resume" && step.task.sessionId
          ? step.task.sessionId
          : startSession(ctx, {
              topicId: step.task.topicId,
              purpose: step.task.action as Exclude<ActionKind, "resume" | "view">,
              skillIds: step.task.skillIds,
            }).sessionId;
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
    }
    ctx.db
      .prepare("UPDATE study_run_steps SET session_id = ?, outcome = ? WHERE run_id = ? AND position = ?")
      .run(sessionId, sessionId ? "started" : "skipped", runId, step.position);
    if (sessionId) {
      ctx.db.prepare("UPDATE study_runs SET current_position = ? WHERE id = ?").run(step.position, runId);
      return sessionId;
    }
  }
  endRunRow(ctx, runId);
  return null;
}

/** Record whether the step was finished, then end its session (saved answers are kept). */
function closeStep(ctx: AppContext, runId: string, step: StepRow) {
  if (step.outcome !== "started") return;
  const outcome = stepIsDone(ctx, step.sessionId) ? "done" : "left";
  ctx.db.prepare("UPDATE study_run_steps SET outcome = ? WHERE run_id = ? AND position = ?").run(outcome, runId, step.position);
  if (step.sessionId) endSession(ctx, step.sessionId, "session");
}

/**
 * Move to the next step. `fromPosition` makes this idempotent: a repeated click for a step that has already been left
 * returns the current position instead of skipping another step. The current session is ended first, which keeps
 * every saved answer (an unfinished check marks unanswered questions as skipped).
 */
export function advanceRun(ctx: AppContext, runId: string, fromPosition: number): RunPosition {
  const run = requireRun(ctx, runId);
  const steps = listSteps(ctx, runId);
  const current = steps.find((s) => s.position === run.currentPosition);
  if (run.status === "ended" || run.currentPosition !== fromPosition) {
    return { runId, sessionId: run.status === "ended" ? null : (current?.sessionId ?? null), done: run.status === "ended" };
  }
  if (current) closeStep(ctx, runId, current);
  const sessionId = openStepFrom(ctx, runId, fromPosition + 1);
  return { runId, sessionId, done: sessionId === null };
}

/** Stop the run now (End session). The current session is ended; answers already saved are kept. */
export function stopRun(ctx: AppContext, runId: string): RunPosition {
  const run = requireRun(ctx, runId);
  const current = listSteps(ctx, runId).find((s) => s.position === run.currentPosition);
  if (run.status === "active" && current) closeStep(ctx, runId, current);
  endRunRow(ctx, runId);
  return { runId, sessionId: null, done: true };
}

// ---------------------------------------------------------------- views

/** What a step counts toward, in plain words. */
const COUNTS_AS: Record<ActionKind, string> = {
  learn: "Help available · counts as practice",
  practice: "Help available · counts as practice",
  check: "No help · can move subtopics to Checked",
  review: "No help · keeps subtopics Checked and moves them toward Secure",
  resume: "Picks up where you left off",
  view: "",
};

function stepTitle(ctx: AppContext, task: StudyTask): string {
  const titles = unitIdsForTask(ctx, task)
    .map((id) => getUnit(ctx.db, id)?.title)
    .filter((x): x is string => !!x);
  return titles.length ? titles.join(" · ") : task.topicTitle;
}

function stepIsDone(ctx: AppContext, sessionId: string | null): boolean {
  if (!sessionId) return true;
  const session = getSession(ctx.db, sessionId);
  if (!session || session.status === "ended") return true;
  const summary = summariseSession(ctx, sessionId);
  return !summary || !isUnfinished(summary);
}

function stepViews(ctx: AppContext, run: RunRow, steps: StepRow[]) {
  return steps.map((s) => {
    // A review of subtopics never yet right on their own is their first no-help check.
    const firstCheck = s.task.action === "review" && unitIdsForTask(ctx, s.task).every((id) => (run.startLevels[id] ?? 0) < CHECKED);
    const kind: ActionKind = firstCheck ? "check" : s.task.action;
    return {
      position: s.position,
      kind,
      kindLabel: STEP_LABEL[kind],
      countsAs: COUNTS_AS[kind],
      title: stepTitle(ctx, s.task),
      topicTitle: s.task.topicTitle,
      reason: s.task.reason,
      estimatedMinutes: s.task.estimatedMinutes,
      sessionId: s.sessionId,
      state:
        s.outcome === "skipped"
          ? ("skipped" as const)
          : s.outcome === "done"
            ? ("done" as const)
            : s.outcome === "left"
              ? ("left" as const)
              : s.outcome === "started" && run.status === "active"
                ? ("current" as const)
                : run.status === "ended"
                  ? ("not_reached" as const)
                  : ("upcoming" as const),
    };
  });
}

/** Run context for the session screen: the stepper and whether this step is finished. Null outside a run. */
export function runForSession(ctx: AppContext, sessionId: string) {
  const row = ctx.db
    .prepare(
      `SELECT r.id FROM study_run_steps s JOIN study_runs r ON r.id = s.run_id
       WHERE s.session_id = ? AND r.status = 'active' AND s.position = r.current_position
       ORDER BY r.created_at DESC LIMIT 1`,
    )
    .get(sessionId) as { id: string } | undefined;
  if (!row) return null;
  const run = requireRun(ctx, row.id);
  const steps = listSteps(ctx, run.id);
  const views = stepViews(ctx, run, steps);
  const remaining = steps.filter((s) => s.position > run.currentPosition).length;
  return {
    runId: run.id,
    position: run.currentPosition,
    stepNumber: views.filter((v) => v.state !== "skipped" && v.position <= run.currentPosition).length,
    totalSteps: views.filter((v) => v.state !== "skipped").length,
    totalMinutes: steps.reduce((n, s) => n + s.task.estimatedMinutes, 0),
    current: views.find((v) => v.position === run.currentPosition)!,
    steps: views,
    stepDone: stepIsDone(ctx, steps.find((s) => s.position === run.currentPosition)?.sessionId ?? null),
    isLast: remaining === 0,
  };
}

export type RunContext = NonNullable<ReturnType<typeof runForSession>>;

/** End-of-run summary: steps and each subtopic's level before and after. */
export function getRunView(ctx: AppContext, runId: string) {
  const run = requireRun(ctx, runId);
  const steps = listSteps(ctx, runId);
  const unitIds = Object.keys(run.startLevels);
  const now = unitLevels(ctx, unitIds);
  const changes = unitIds
    .map((id) => {
      const unit = getUnit(ctx.db, id);
      if (!unit) return null;
      const topic = getTopic(ctx.db, unit.topicId);
      const from = run.startLevels[id];
      const to = now[id];
      return { unitId: id, title: unit.title, topicId: unit.topicId, topicTitle: topic?.title ?? "", from, to, fromLabel: LEVELS[from].name, toLabel: LEVELS[to].name };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  const plan = planFor(ctx, run.budgetMinutes, { courseId: run.scopeCourseId ?? undefined, topicId: run.scopeTopicId ?? undefined });
  const next = plan.nextScheduledCheck;
  return {
    id: run.id,
    status: run.status,
    scope: { courseId: run.scopeCourseId, topicId: run.scopeTopicId },
    steps: stepViews(ctx, run, steps),
    changes,
    moreReady: plan.plan.some((t) => t.action !== "view"),
    nextCheck: next
      ? { topicId: next.topicId, topicTitle: next.topicTitle, focus: next.focus, dueAt: next.dueAt, dueWhen: relativeWhen(next.dueAt, ctx.clock.now(), ctx.timezone) }
      : null,
    currentSessionId: run.status === "active" ? (steps.find((s) => s.position === run.currentPosition)?.sessionId ?? null) : null,
  };
}

export type RunView = ReturnType<typeof getRunView>;
