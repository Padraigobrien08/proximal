// Pure scheduling policy (heuristic-v1). No Date.now(): callers pass `now`. The study plan lives in plan.ts.
import { MS_DAY } from "./types";

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
