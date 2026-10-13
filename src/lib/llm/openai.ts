import "server-only";
import OpenAI from "openai";
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
  type ActivityFeedbackInput,
  type PageTranscription,
  type UserContent,
} from "./types";

export const OPENAI_TIMEOUT_MS = 60_000;
/** SDK retries cover 408/409/429/5xx and connection errors. Kept low so a learner is not left waiting. */
export const OPENAI_MAX_RETRIES = 1;
const MAX_TUTOR_CHARS = 3000;

export interface OpenAIProviderOptions {
  apiKey: string;
  /** Per-job models and limits. */
  jobs?: JobConfigs;
  /** Shorthand: one model for every job (tests, simple setups). */
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Injected for tests. */
  client?: Pick<OpenAI, "responses">;
}

type Usage = ProviderMeta["usage"];
type InputMessage = { role: "user" | "assistant"; content: string | OpenAI.Responses.ResponseInputMessageContentList };

function toOpenAIContent(content: UserContent): InputMessage["content"] {
  if (typeof content === "string") return content;
  return content.map((c) =>
    c.type === "text"
      ? { type: "input_text" as const, text: c.text }
      : { type: "input_image" as const, image_url: `data:${c.mediaType};base64,${c.base64}`, detail: "high" as const },
  );
}

/**
 * OpenAI adapter over the Responses API. Same contract as the Claude adapter: instructions carry the role,
 * learner/document text is user-turn data, output is schema-constrained and re-validated with Zod, one bounded
 * repair turn, no tools offered, and nothing is stored on OpenAI's side (`store: false`).
 */
export class OpenAIProvider implements LearningProvider {
  readonly mode = "live" as const;
  readonly vendor = "openai" as const;
  /** Assessment model (the job that produces evidence); see `models` for every job. */
  readonly model: string;
  readonly models: JobModels;
  private jobs: JobConfigs;
  private client: Pick<OpenAI, "responses">;

  constructor(opts: OpenAIProviderOptions) {
    if (!opts.jobs && !opts.model) throw new Error("OpenAIProvider needs jobs or a model.");
    this.jobs = opts.jobs ?? uniformJobs(opts.model!);
    this.models = jobModels(this.jobs);
    this.model = this.jobs.assess.model;
    this.client =
      opts.client ??
      new OpenAI({
        apiKey: opts.apiKey,
        timeout: opts.timeoutMs ?? OPENAI_TIMEOUT_MS,
        maxRetries: opts.maxRetries ?? OPENAI_MAX_RETRIES,
      });
  }

  private async call(params: {
    job: LlmJob;
    instructions: string;
    input: InputMessage[];
    schema?: { name: string; schema: Record<string, unknown> };
  }): Promise<{ text: string; usage: Usage }> {
    const cfg = this.jobs[params.job];
    let res: OpenAI.Responses.Response;
    try {
      res = await this.client.responses.create(
        {
          model: cfg.model,
          instructions: params.instructions,
          input: params.input,
          max_output_tokens: cfg.maxOutputTokens,
          store: false,
          ...(cfg.effort ? { reasoning: { effort: cfg.effort as OpenAI.ReasoningEffort } } : {}),
          ...(params.schema
            ? { text: { format: { type: "json_schema", name: params.schema.name, schema: params.schema.schema, strict: true } } }
            : {}),
        },
        { timeout: cfg.timeoutMs },
      );
    } catch (err) {
      throw mapOpenAIError(err);
    }

    // No tools are offered; any tool or function call (e.g. a request to write application state) is rejected.
    if (res.output.some((item) => item.type !== "message" && item.type !== "reasoning")) {
      throw new ProviderError("Model attempted a tool call; rejected.", "provider_malformed", true);
    }
    const parts = res.output.flatMap((item) => (item.type === "message" ? item.content : []));
    if (parts.some((p) => p.type === "refusal")) {
      throw new ProviderError("The model declined this request.", "provider_refusal", false);
    }
    if (res.status === "incomplete") {
      if (res.incomplete_details?.reason === "content_filter") {
        throw new ProviderError("The provider's content filter stopped this response.", "provider_refusal", false);
      }
      throw new ProviderError("Model output was cut off at the output limit.", "provider_malformed", true);
    }
    if (res.status === "failed" || res.error) {
      throw new ProviderError(`The provider reported a failed response: ${res.error?.message ?? "unknown error"}`, "provider_unavailable", true);
    }
    const text = parts
      .filter((p): p is OpenAI.Responses.ResponseOutputText => p.type === "output_text")
      .map((p) => p.text)
      .join("");
    return {
      text,
      usage: res.usage ? { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens } : null,
    };
  }

  /** Parse + validate JSON; one bounded repair turn is permitted (never by changing the rubric). */
  private async structured<T>(
    job: LlmJob,
    instructions: string,
    content: UserContent,
    schema: { name: string; schema: Record<string, unknown> },
    zodSchema: z.ZodType<T>,
  ): Promise<{ value: T; usage: Usage }> {
    const first = await this.call({ job, instructions, input: [{ role: "user", content: toOpenAIContent(content) }], schema });
    const parsed = safeParse(first.text, zodSchema);
    if (parsed.ok) return { value: parsed.value, usage: first.usage };
    const repair = await this.call({
      job,
      instructions,
      input: [
        { role: "user", content: toOpenAIContent(content) },
        { role: "assistant", content: first.text.slice(0, 8000) || "{}" },
        {
          role: "user",
          content: `Your previous output did not match the required schema: ${parsed.error.slice(0, 500)}\nReturn the corrected structured output only.`,
        },
      ],
      schema,
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
      { name: "assessor_output", schema: assessorJsonSchema(input.rubric) },
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
      { name: "curriculum_draft", schema: curriculumJsonSchema },
      curriculumDraftSchema,
    );
    return { draft: value, meta: this.meta("curriculum", CURRICULUM_PROMPT_VERSION, usage) };
  }

  async tutor(input: TutorInput): Promise<{ explanation: string; meta: ProviderMeta }> {
    const { text, usage } = await this.call({
      job: "tutor",
      instructions: TUTOR_SYSTEM,
      input: [{ role: "user", content: tutorUserContent(input) }],
    });
    const explanation = text.trim().slice(0, MAX_TUTOR_CHARS);
    if (!explanation) throw new ProviderError("Tutor returned no text.", "provider_malformed", true);
    return { explanation, meta: this.meta("tutor", TUTOR_PROMPT_VERSION, usage) };
  }

  async chat(input: ChatInput): Promise<{ reply: ChatReply; meta: ProviderMeta }> {
    const { value, usage } = await this.structured("tutor", CHAT_SYSTEM, chatUserContent(input), { name: "chat_reply", schema: chatJsonSchema }, chatReplySchema);
    return { reply: value, meta: this.meta("tutor", CHAT_PROMPT_VERSION, usage) };
  }

  /** PACER proposals under the curriculum job's model. Ids, quotes and labels are validated server-side afterwards. */
  async classifyPacer(input: PacerClassifyInput): Promise<{ results: unknown[]; meta: ProviderMeta }> {
    const { value, usage } = await this.structured(
      "curriculum",
      PACER_SYSTEM,
      pacerUserContent(input),
      { name: "pacer_classification", schema: pacerJsonSchema },
      wireBatchSchema,
    );
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
      { name: "question_drafts", schema: draftBatchJsonSchema },
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
      { name: "page_transcription", schema: transcriptionJsonSchema },
      transcriptionSchema,
    );
    return { transcription: value, meta: this.meta("curriculum", TRANSCRIBE_PROMPT_VERSION, usage) };
  }

  /** Coaching on a learning-activity response under the tutor job's model. Plain text; never a grade. */
  async activityFeedback(input: ActivityFeedbackInput): Promise<{ feedback: string; meta: ProviderMeta }> {
    const { text, usage } = await this.call({
      job: "tutor",
      instructions: ACTIVITY_FEEDBACK_SYSTEM,
      input: [{ role: "user", content: activityFeedbackUserContent(input) }],
    });
    const feedback = text.trim().slice(0, MAX_TUTOR_CHARS);
    if (!feedback) throw new ProviderError("Tutor returned no feedback.", "provider_malformed", true);
    return { feedback, meta: this.meta("tutor", ACTIVITY_FEEDBACK_PROMPT_VERSION, usage) };
  }

  /** Records the model that actually ran this job. */
  private meta(job: LlmJob, promptVersion: string, usage: Usage): ProviderMeta {
    return { mode: "live", vendor: "openai", model: this.jobs[job].model, promptVersion, usage };
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

export function mapOpenAIError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return new ProviderError("The live assessor timed out. Your answer is saved; you can retry.", "provider_timeout", true);
  }
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
    return new ProviderError("OpenAI rejected the configured API key.", "provider_unavailable", false);
  }
  if (err instanceof OpenAI.NotFoundError) {
    return new ProviderError("The configured OPENAI_MODEL was not found for this API key.", "provider_unavailable", false);
  }
  if (err instanceof OpenAI.BadRequestError) {
    return new ProviderError(`OpenAI rejected the request: ${err.message.slice(0, 200)}`, "provider_unavailable", false);
  }
  if (err instanceof OpenAI.RateLimitError) {
    // 429 covers two different situations: a short-term rate limit (wait and retry) and an exhausted account quota or
    // billing limit (retrying will not help until it is raised).
    // OpenAI reports exhausted credit as type insufficient_quota (code insufficient_quota or credit_balance_exhausted).
    if (err.type === "insufficient_quota" || err.code === "insufficient_quota" || err.code === "credit_balance_exhausted") {
      return new ProviderError(
        "OpenAI says the account has no credits or quota left. Add credits in OpenAI billing, then retry; your answer is saved.",
        "provider_unavailable",
        false,
      );
    }
    return new ProviderError("OpenAI rate limit reached for this model. Wait a minute and retry; your answer is saved.", "provider_unavailable", true);
  }
  if (err instanceof OpenAI.InternalServerError) {
    return new ProviderError("OpenAI is unavailable. Your answer is saved; you can retry.", "provider_unavailable", true);
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new ProviderError("Could not reach OpenAI. Your answer is saved; you can retry.", "provider_unavailable", true);
  }
  return new ProviderError("Unexpected OpenAI error.", "provider_unavailable", true);
}
