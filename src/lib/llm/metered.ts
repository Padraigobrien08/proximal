// Usage metering, daily caps and a concurrency limit around a live provider. Pure wrapper: the provider contract
// (and every validation downstream) is unchanged.
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { UsageLimits } from "../env";
import { logEvent } from "../logger";
import type { LlmJob } from "./jobs";
import {
  OFFLINE_CHAT_MESSAGE,
  ProviderError,
  type AssessmentInput,
  type CurriculumInput,
  type LearningProvider,
  type ProviderMeta,
  type TutorInput,
  type ChatInput,
  type ChatReply,
  type PacerClassifyInput,
  type QuestionDraftInput,
  type TranscribeInput,
  type PageTranscription,
  OFFLINE_OCR_MESSAGE,
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Process-wide counting semaphore (the app is a single Node process). */
class Semaphore {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(public limit: number) {}
  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    return () => {
      this.active -= 1;
      this.waiting.shift()?.();
    };
  }
  get inFlight() {
    return this.active;
  }
}

const g = globalThis as unknown as { __proximalSemaphore?: Semaphore };
function semaphore(limit: number): Semaphore {
  if (!g.__proximalSemaphore) g.__proximalSemaphore = new Semaphore(limit);
  g.__proximalSemaphore.limit = limit;
  return g.__proximalSemaphore;
}

export interface UsageWindow {
  calls: number;
  tokens: number;
}

/** Live calls and tokens in the rolling 24 hours before `now` (blocked attempts are not counted). */
export function usageSince(db: Database.Database, now: number): UsageWindow {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS tokens
       FROM provider_calls WHERE started_at > ? AND status != 'blocked'`,
    )
    .get(now - DAY_MS) as { calls: number; tokens: number };
  return row;
}

export interface MeteredOptions {
  db: Database.Database;
  limits: UsageLimits;
  now?: () => number;
}

export class MeteredProvider implements LearningProvider {
  readonly mode: LearningProvider["mode"];
  readonly vendor: LearningProvider["vendor"];
  readonly model: string | null;
  readonly models: LearningProvider["models"];
  private now: () => number;

  constructor(
    private inner: LearningProvider,
    private opts: MeteredOptions,
  ) {
    this.mode = inner.mode;
    this.vendor = inner.vendor;
    this.model = inner.model;
    this.models = inner.models;
    this.now = opts.now ?? Date.now;
  }

  private record(row: {
    job: LlmJob;
    model: string;
    promptVersion: string | null;
    status: "ok" | "error" | "blocked";
    errorCode: string | null;
    latencyMs: number;
    usage: ProviderMeta["usage"];
    startedAt: number;
  }) {
    this.opts.db
      .prepare(
        `INSERT INTO provider_calls (id, job, vendor, model, prompt_version, status, error_code, latency_ms, input_tokens, output_tokens, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        row.job,
        this.vendor ?? "unknown",
        row.model,
        row.promptVersion,
        row.status,
        row.errorCode,
        row.latencyMs,
        row.usage?.inputTokens ?? null,
        row.usage?.outputTokens ?? null,
        row.startedAt,
      );
    logEvent(
      "provider_call",
      {
        job: row.job,
        vendor: this.vendor ?? "unknown",
        model: row.model,
        status: row.status,
        errorCode: row.errorCode,
        latencyMs: row.latencyMs,
        inputTokens: row.usage?.inputTokens ?? null,
        outputTokens: row.usage?.outputTokens ?? null,
      },
      row.status === "ok" ? "info" : "warn",
    );
  }

  /** Daily caps are checked before any paid call; a blocked call is recorded and fails retryably. */
  private checkCaps(job: LlmJob, model: string) {
    const { dailyCalls, dailyTokens } = this.opts.limits;
    if (dailyCalls === null && dailyTokens === null) return;
    const used = usageSince(this.opts.db, this.now());
    let reason: string | null = null;
    if (dailyCalls !== null && used.calls >= dailyCalls) reason = `daily call limit reached (${used.calls}/${dailyCalls}, PROXIMAL_DAILY_CALL_LIMIT)`;
    else if (dailyTokens !== null && used.tokens >= dailyTokens)
      reason = `daily token limit reached (${used.tokens}/${dailyTokens}, PROXIMAL_DAILY_TOKEN_LIMIT)`;
    if (!reason) return;
    this.record({ job, model, promptVersion: null, status: "blocked", errorCode: "usage_limit", latencyMs: 0, usage: null, startedAt: this.now() });
    throw new ProviderError(
      `Usage limit: ${reason}. Your answer is saved; retry once usage falls below the limit or after raising it in .env.`,
      "provider_unavailable",
      true,
    );
  }

  private async run<T extends { meta: ProviderMeta }>(job: LlmJob, fn: () => Promise<T>): Promise<T> {
    const model = this.models?.[job] ?? this.model ?? "unknown";
    this.checkCaps(job, model);
    const release = await semaphore(this.opts.limits.maxConcurrent).acquire();
    const startedAt = this.now();
    try {
      const res = await fn();
      this.record({
        job,
        model: res.meta.model ?? model,
        promptVersion: res.meta.promptVersion,
        status: "ok",
        errorCode: null,
        latencyMs: this.now() - startedAt,
        usage: res.meta.usage,
        startedAt,
      });
      return res;
    } catch (err) {
      this.record({
        job,
        model,
        promptVersion: null,
        status: "error",
        errorCode: err instanceof ProviderError ? err.code : "unexpected",
        latencyMs: this.now() - startedAt,
        usage: null,
        startedAt,
      });
      throw err;
    } finally {
      release();
    }
  }

  assessAnswer(input: AssessmentInput) {
    return this.run("assess", () => this.inner.assessAnswer(input));
  }
  generateCurriculum(input: CurriculumInput) {
    return this.run("curriculum", () => this.inner.generateCurriculum(input));
  }
  tutor(input: TutorInput) {
    return this.run("tutor", () => this.inner.tutor(input));
  }
  chat(input: ChatInput): Promise<{ reply: ChatReply; meta: ProviderMeta }> {
    const inner = this.inner;
    if (!inner.chat) return Promise.reject(new ProviderError(OFFLINE_CHAT_MESSAGE, "offline_unsupported", false));
    return this.run("tutor", () => inner.chat!(input));
  }
  classifyPacer(input: PacerClassifyInput): Promise<{ results: unknown[]; meta: ProviderMeta }> {
    const inner = this.inner;
    if (!inner.classifyPacer) return Promise.reject(new ProviderError("This provider cannot classify learning objectives.", "provider_unavailable", false));
    return this.run("curriculum", () => inner.classifyPacer!(input));
  }
  transcribePage(input: TranscribeInput): Promise<{ transcription: PageTranscription; meta: ProviderMeta }> {
    const inner = this.inner;
    if (!inner.transcribePage) return Promise.reject(new ProviderError(OFFLINE_OCR_MESSAGE, "offline_unsupported", false));
    return this.run("curriculum", () => inner.transcribePage!(input));
  }
  draftQuestions(input: QuestionDraftInput): Promise<{ batch: unknown; meta: ProviderMeta }> {
    const inner = this.inner;
    if (!inner.draftQuestions) return Promise.reject(new ProviderError("This provider cannot draft questions.", "provider_unavailable", false));
    return this.run("curriculum", () => inner.draftQuestions!(input));
  }
}

/** Current process-wide in-flight count (for status/doctor). */
export function inFlightCalls(): number {
  return g.__proximalSemaphore?.inFlight ?? 0;
}
