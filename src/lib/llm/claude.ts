import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { AssessorOutput } from "../domain/types";
import {
  ASSESSOR_PROMPT_VERSION,
  ASSESSOR_SYSTEM,
  assessorUserContent,
  CURRICULUM_PROMPT_VERSION,
  CURRICULUM_SYSTEM,
  curriculumUserContent,
  TUTOR_PROMPT_VERSION,
  TUTOR_SYSTEM,
  tutorUserContent,
  CHAT_PROMPT_VERSION,
  CHAT_SYSTEM,
  chatUserContent,
  PACER_PROMPT_VERSION,
  QUESTION_DRAFT_PROMPT_VERSION,
  MATERIAL_DRAFT_PROMPT_VERSION,
  MATERIAL_DRAFT_SYSTEM,
  materialDraftUserContent,
  ACTIVITY_FEEDBACK_PROMPT_VERSION,
  ACTIVITY_FEEDBACK_SYSTEM,
  activityFeedbackUserContent,
  TRANSCRIBE_PROMPT_VERSION,
  TRANSCRIBE_SYSTEM,
  transcribeUserText,
  QUESTION_DRAFT_SYSTEM,
  questionDraftUserContent,
  PACER_SYSTEM,
  pacerUserContent,
} from "./prompts";
import { fromWire, pacerJsonSchema, wireBatchSchema } from "../pacer/validation";
import { draftBatchJsonSchema, looseDraftBatchSchema } from "../questions/drafts";
import { materialDraftJsonSchema } from "../pacer/materialDrafts";
import { jobModels, uniformJobs, type JobConfigs, type JobModels, type LlmJob } from "./jobs";
import {
  assessorJsonSchema,
  chatJsonSchema,
  chatReplySchema,
  curriculumDraftSchema,
  curriculumJsonSchema,
  looseAssessorOutputSchema,
  transcriptionJsonSchema,
  transcriptionSchema,
} from "./schemas";
import {
  ProviderError,
  type AssessmentInput,
  type CurriculumDraft,
  type CurriculumInput,
  type LearningProvider,
  type ProviderMeta,
  type TutorInput,
  type ChatInput,
  type ChatReply,
  type PacerClassifyInput,
  type QuestionDraftInput,
  type TranscribeInput,
  type MaterialDraftInput,
  type ActivityFeedbackInput,
  type PageTranscription,
  type UserContent,
} from "./types";

export const CLAUDE_TIMEOUT_MS = 60_000;
/** SDK retries cover 408/409/429/5xx and connection errors. Kept low so a learner is not left waiting. */
export const CLAUDE_MAX_RETRIES = 1;
const MAX_TUTOR_CHARS = 3000;

export interface ClaudeProviderOptions {
  apiKey: string;
  /** Per-job models and limits. */
  jobs?: JobConfigs;
  /** Shorthand: one model for every job (tests, simple setups). */
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Injected for tests. */
  client?: Pick<Anthropic, "messages">;
}

type Usage = ProviderMeta["usage"];

function toClaudeContent(content: UserContent): Anthropic.MessageParam["content"] {
  if (typeof content === "string") return content;
  return content.map((c) =>
    c.type === "text"
      ? { type: "text" as const, text: c.text }
      : { type: "image" as const, source: { type: "base64" as const, media_type: c.mediaType, data: c.base64 } },
  );
}

export class ClaudeProvider implements LearningProvider {
  readonly mode = "live" as const;
  readonly vendor = "anthropic" as const;
  /** Assessment model (the job that produces evidence); see `models` for every job. */
  readonly model: string;
  readonly models: JobModels;
  private jobs: JobConfigs;
  private client: Pick<Anthropic, "messages">;

  constructor(opts: ClaudeProviderOptions) {
    if (!opts.jobs && !opts.model) throw new Error("ClaudeProvider needs jobs or a model.");
    this.jobs = opts.jobs ?? uniformJobs(opts.model!);
    this.models = jobModels(this.jobs);
    this.model = this.jobs.assess.model;
    this.client =
      opts.client ??
      new Anthropic({
        apiKey: opts.apiKey,
        timeout: opts.timeoutMs ?? CLAUDE_TIMEOUT_MS,
        maxRetries: opts.maxRetries ?? CLAUDE_MAX_RETRIES,
      });
  }

  private async call(params: {
    job: LlmJob;
    system: string;
    content: UserContent;
    schema?: Record<string, unknown>;
    priorTurns?: Anthropic.MessageParam[];
  }): Promise<{ text: string; usage: Usage }> {
    const cfg = this.jobs[params.job];
    const outputConfig: Anthropic.OutputConfig = {
      ...(params.schema ? { format: { type: "json_schema", schema: params.schema } } : {}),
      ...(cfg.effort ? { effort: cfg.effort as NonNullable<Anthropic.OutputConfig["effort"]> } : {}),
    };
    let res: Anthropic.Message;
    try {
      res = await this.client.messages.create(
        {
          model: cfg.model,
          max_tokens: cfg.maxOutputTokens,
          system: params.system,
          messages: [...(params.priorTurns ?? []), { role: "user", content: toClaudeContent(params.content) }],
          ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
        },
        { timeout: cfg.timeoutMs },
      );
    } catch (err) {
      throw mapSdkError(err);
    }
    if (res.stop_reason === "refusal") throw new ProviderError("The model declined this request.", "provider_refusal", false);
    // No tools are offered; any tool call (e.g. a request to write application state) is rejected.
    if (res.content.some((b) => b.type === "tool_use" || b.type === "server_tool_use")) {
      throw new ProviderError("Model attempted a tool call; rejected.", "provider_malformed", true);
    }
    if (res.stop_reason === "max_tokens") {
      throw new ProviderError("Model output was cut off at the output limit.", "provider_malformed", true);
    }
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return { text, usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens } };
  }

  /** Parse + validate JSON; one bounded repair turn is permitted (never by changing the rubric). */
  private async structured<T>(
    job: LlmJob,
    system: string,
    content: UserContent,
    jsonSchema: Record<string, unknown>,
    zodSchema: z.ZodType<T>,
  ): Promise<{ value: T; usage: Usage }> {
    const first = await this.call({ job, system, content, schema: jsonSchema });
    const parsed = safeParse(first.text, zodSchema);
    if (parsed.ok) return { value: parsed.value, usage: first.usage };
    const repair = await this.call({
      job,
      system,
      content: `Your previous output did not match the required schema: ${parsed.error.slice(0, 500)}\nReturn the corrected structured output only.`,
      schema: jsonSchema,
      priorTurns: [
        { role: "user", content: toClaudeContent(content) },
        { role: "assistant", content: first.text.slice(0, 8000) || "{}" },
      ],
    });
    const second = safeParse(repair.text, zodSchema);
    if (!second.ok) throw new ProviderError(`Model output failed validation after one repair: ${second.error}`, "provider_malformed", true);
    return { value: second.value, usage: sumUsage(first.usage, repair.usage) };
  }

  async assessAnswer(input: AssessmentInput): Promise<{ output: AssessorOutput; meta: ProviderMeta }> {
    const { value, usage } = await this.structured(
      "assess",
      ASSESSOR_SYSTEM,
      assessorUserContent(input),
      assessorJsonSchema(input.rubric),
      looseAssessorOutputSchema,
    );
    // Unknown/duplicate criterion ids and quote checks are enforced server-side by validateAssessorOutput.
    return { output: value, meta: this.meta("assess", ASSESSOR_PROMPT_VERSION, usage) };
  }

  async generateCurriculum(input: CurriculumInput): Promise<{ draft: CurriculumDraft; meta: ProviderMeta }> {
    const { value, usage } = await this.structured(
      "curriculum",
      CURRICULUM_SYSTEM,
      curriculumUserContent(input),
      curriculumJsonSchema,
      curriculumDraftSchema,
    );
    return { draft: value, meta: this.meta("curriculum", CURRICULUM_PROMPT_VERSION, usage) };
  }

  async tutor(input: TutorInput): Promise<{ explanation: string; meta: ProviderMeta }> {
    const { text, usage } = await this.call({ job: "tutor", system: TUTOR_SYSTEM, content: tutorUserContent(input) });
    const explanation = text.trim().slice(0, MAX_TUTOR_CHARS);
    if (!explanation) throw new ProviderError("Tutor returned no text.", "provider_malformed", true);
    return { explanation, meta: this.meta("tutor", TUTOR_PROMPT_VERSION, usage) };
  }

  async chat(input: ChatInput): Promise<{ reply: ChatReply; meta: ProviderMeta }> {
    const { value, usage } = await this.structured("tutor", CHAT_SYSTEM, chatUserContent(input), chatJsonSchema, chatReplySchema);
    return { reply: value, meta: this.meta("tutor", CHAT_PROMPT_VERSION, usage) };
  }

  /** PACER proposals under the curriculum job's model. Ids, quotes and labels are validated server-side afterwards. */
  async classifyPacer(input: PacerClassifyInput): Promise<{ results: unknown[]; meta: ProviderMeta }> {
    const { value, usage } = await this.structured("curriculum", PACER_SYSTEM, pacerUserContent(input), pacerJsonSchema, wireBatchSchema);
    return { results: value.results.map(fromWire), meta: this.meta("curriculum", PACER_PROMPT_VERSION, usage) };
  }

  /**
   * Question drafts under the curriculum job's model. Only the outer shape is enforced here: each question is checked
   * server-side on its own, so one malformed question does not discard the other.
   */
  async draftQuestions(input: QuestionDraftInput): Promise<{ batch: unknown; meta: ProviderMeta }> {
    const { value, usage } = await this.structured(
      "curriculum",
      QUESTION_DRAFT_SYSTEM,
      questionDraftUserContent(input),
      draftBatchJsonSchema,
      looseDraftBatchSchema,
    );
    return { batch: value, meta: this.meta("curriculum", QUESTION_DRAFT_PROMPT_VERSION, usage) };
  }

  /** Scanned-page transcription under the curriculum job's model. The image goes in the user turn as data. */
  async transcribePage(input: TranscribeInput): Promise<{ transcription: PageTranscription; meta: ProviderMeta }> {
    const { value, usage } = await this.structured(
      "curriculum",
      TRANSCRIBE_SYSTEM,
      [
        { type: "image", mediaType: input.image.mediaType, base64: input.image.base64 },
        { type: "text", text: transcribeUserText(input.page) },
      ],
      transcriptionJsonSchema,
      transcriptionSchema,
    );
    return { transcription: value, meta: this.meta("curriculum", TRANSCRIBE_PROMPT_VERSION, usage) };
  }

  /** Coaching on a learning-activity response under the tutor job's model. Plain text; never a grade. */
  async activityFeedback(input: ActivityFeedbackInput): Promise<{ feedback: string; meta: ProviderMeta }> {
    const { text, usage } = await this.call({ job: "tutor", system: ACTIVITY_FEEDBACK_SYSTEM, content: activityFeedbackUserContent(input) });
    const feedback = text.trim().slice(0, MAX_TUTOR_CHARS);
    if (!feedback) throw new ProviderError("Tutor returned no feedback.", "provider_malformed", true);
    return { feedback, meta: this.meta("tutor", ACTIVITY_FEEDBACK_PROMPT_VERSION, usage) };
  }

  /** Activity material under the curriculum job's model. Grounding and pairing are checked server-side afterwards. */
  async draftMaterial(input: MaterialDraftInput): Promise<{ draft: unknown; meta: ProviderMeta }> {
    const { value, usage } = await this.structured(
      "curriculum",
      MATERIAL_DRAFT_SYSTEM,
      materialDraftUserContent(input),
      materialDraftJsonSchema,
      z.record(z.string(), z.unknown()),
    );
    return { draft: value, meta: this.meta("curriculum", MATERIAL_DRAFT_PROMPT_VERSION, usage) };
  }

  /** Records the model that actually ran this job. */
  private meta(job: LlmJob, promptVersion: string, usage: Usage): ProviderMeta {
    return { mode: "live", vendor: "anthropic", model: this.jobs[job].model, promptVersion, usage };
  }
}

function safeParse<T>(text: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "output was not valid JSON" };
  }
  const r = schema.safeParse(raw);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: r.error.message };
}

function sumUsage(a: Usage, b: Usage): Usage {
  if (!a || !b) return a ?? b;
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

export function mapSdkError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new ProviderError("The live assessor timed out. Your answer is saved; you can retry.", "provider_timeout", true);
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError("Live provider rejected the configured credentials.", "provider_unavailable", false);
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new ProviderError("The configured ANTHROPIC_MODEL was not found.", "provider_unavailable", false);
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new ProviderError(`Live provider rejected the request: ${err.message.slice(0, 200)}`, "provider_unavailable", false);
  }
  if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError) {
    return new ProviderError("Live provider is busy or unavailable. Your answer is saved; you can retry.", "provider_unavailable", true);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError("Could not reach the live provider. Your answer is saved; you can retry.", "provider_unavailable", true);
  }
  return new ProviderError("Unexpected live provider error.", "provider_unavailable", true);
}
