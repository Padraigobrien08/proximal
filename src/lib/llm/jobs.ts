// The three model jobs and their per-job settings. Pure and client-safe (no SDK imports).

export type LlmJob = "assess" | "curriculum" | "tutor";
export const LLM_JOBS: LlmJob[] = ["assess", "curriculum", "tutor"];

export const JOB_LABEL: Record<LlmJob, string> = {
  assess: "Assessment",
  curriculum: "Curriculum",
  tutor: "Tutor",
};

/** Env-var suffix per job: OPENAI_MODEL_ASSESS, ANTHROPIC_EFFORT_TUTOR, ... */
export const JOB_ENV_SUFFIX: Record<LlmJob, string> = {
  assess: "ASSESS",
  curriculum: "CURRICULUM",
  tutor: "TUTOR",
};

export interface JobConfig {
  model: string;
  /** Optional reasoning effort, sent only when configured (some models reject it). */
  effort?: string;
  timeoutMs: number;
  maxOutputTokens: number;
}

export type JobConfigs = Record<LlmJob, JobConfig>;

/**
 * Per-job limits. Grading must be careful but answer within a minute; curriculum drafting reads a whole lecture
 * and runs rarely; the tutor is interactive and should come back quickly.
 */
export const JOB_LIMITS: Record<LlmJob, { timeoutMs: number; maxOutputTokens: number }> = {
  assess: { timeoutMs: 60_000, maxOutputTokens: 8000 },
  curriculum: { timeoutMs: 180_000, maxOutputTokens: 16000 },
  tutor: { timeoutMs: 30_000, maxOutputTokens: 4000 },
};

/** Same model (and no effort override) for every job: used by tests and simple setups. */
export function uniformJobs(model: string): JobConfigs {
  return {
    assess: { model, ...JOB_LIMITS.assess },
    curriculum: { model, ...JOB_LIMITS.curriculum },
    tutor: { model, ...JOB_LIMITS.tutor },
  };
}

export type JobModels = Record<LlmJob, string>;

export function jobModels(jobs: JobConfigs): JobModels {
  return { assess: jobs.assess.model, curriculum: jobs.curriculum.model, tutor: jobs.tutor.model };
}
