// Runs background jobs. Handlers reuse the services' own safeguards (assessment lease + compare-and-set), so a job
// that runs twice can never produce two results.
import { claimJob, claimNextJob, finishJob, type JobRow } from "../db/jobsRepo";
import { logEvent } from "../logger";
import { assessAttempt } from "../services/assessments";
import type { AppContext } from "../services/context";
import { AppError } from "../services/errors";
import { generateQuestionDrafts } from "../services/questionDrafts";

/** Run one claimed job to completion. Never throws: every outcome is recorded on the job row. */
export async function runJob(ctx: AppContext, job: JobRow): Promise<void> {
  try {
    if (job.kind === "assess_attempt") {
      // A provider failure is saved on the attempt itself (provider_error, explicit retry), so the job is done.
      await assessAttempt(ctx, job.refId);
    } else {
      await generateQuestionDrafts(ctx, job.refId);
    }
    finishJob(ctx.db, job.id, "done", null, ctx.clock.now());
  } catch (err) {
    const message = err instanceof AppError ? err.message : "Unexpected error while running this task.";
    if (!(err instanceof AppError)) {
      logEvent("job_error", { kind: job.kind, name: (err as Error)?.name ?? "unknown", message: String((err as Error)?.message ?? err).slice(0, 300) }, "error");
    }
    finishJob(ctx.db, job.id, "failed", message, ctx.clock.now());
  }
}

/**
 * Claim and run jobs until none are runnable, with at most `concurrency` in flight. Each job gets a fresh context so
 * provider settings changed in .env apply to the next job. Used by the worker and, synchronously, by tests.
 */
export async function drainJobs(makeCtx: () => AppContext, concurrency = 2): Promise<number> {
  let ran = 0;
  const lane = async () => {
    for (;;) {
      const ctx = makeCtx();
      const job = claimNextJob(ctx.db, ctx.clock.now());
      if (!job) return;
      await runJob(ctx, job);
      ran += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, lane));
  return ran;
}

/** Run one queued job now, in this request (AppContext.inlineJobs). No-op if another runner already has it. */
export async function runJobInline(ctx: AppContext, jobId: string): Promise<void> {
  const job = claimJob(ctx.db, jobId, ctx.clock.now());
  if (job) await runJob(ctx, job);
}
