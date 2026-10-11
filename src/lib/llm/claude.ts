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
} from "./prompts";
import {
  assessorJsonSchema,
  curriculumDraftSchema,
  curriculumJsonSchema,
  looseAssessorOutputSchema,
} from "./schemas";
import {
  ProviderError,
  type AssessmentInput,
  type CurriculumDraft,
  type CurriculumInput,
  type LearningProvider,
  type ProviderMeta,
  type TutorInput,
} from "./types";

export const CLAUDE_TIMEOUT_MS = 60_000;
/** SDK retries cover 408/409/429/5xx and connection errors. Kept low so a learner is not left waiting. */
export const CLAUDE_MAX_RETRIES = 1;
const MAX_TUTOR_CHARS = 3000;

export interface ClaudeProviderOptions {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Injected for tests. */
  client?: Pick<Anthropic, "messages">;
}

type Usage = ProviderMeta["usage"];

export class ClaudeProvider implements LearningProvider {
  readonly mode = "live" as const;
  readonly vendor = "anthropic" as const;
  readonly model: string;
  private client: Pick<Anthropic, "messages">;

  constructor(opts: ClaudeProviderOptions) {
    this.model = opts.model;
    this.client =
      opts.client ??
      new Anthropic({
        apiKey: opts.apiKey,
        timeout: opts.timeoutMs ?? CLAUDE_TIMEOUT_MS,
        maxRetries: opts.maxRetries ?? CLAUDE_MAX_RETRIES,
      });
  }

  private async call(params: {
    system: string;
    content: string;
    maxTokens: number;
    schema?: Record<string, unknown>;
    priorTurns?: Anthropic.MessageParam[];
  }): Promise<{ text: string; usage: Usage }> {
    let res: Anthropic.Message;
    try {
      res = await this.client.messages.create({
        model: this.model,
        max_tokens: params.maxTokens,
        system: params.system,
        messages: [...(params.priorTurns ?? []), { role: "user", content: params.content }],
        ...(params.schema ? { output_config: { format: { type: "json_schema", schema: params.schema } } } : {}),
      });
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
    system: string,
    content: string,
    jsonSchema: Record<string, unknown>,
    zodSchema: z.ZodType<T>,
    maxTokens: number,
  ): Promise<{ value: T; usage: Usage }> {
    const first = await this.call({ system, content, maxTokens, schema: jsonSchema });
    const parsed = safeParse(first.text, zodSchema);
    if (parsed.ok) return { value: parsed.value, usage: first.usage };
    const repair = await this.call({
      system,
      content: `Your previous output did not match the required schema: ${parsed.error.slice(0, 500)}\nReturn the corrected structured output only.`,
      maxTokens,
      schema: jsonSchema,
      priorTurns: [
        { role: "user", content },
        { role: "assistant", content: first.text.slice(0, 8000) || "{}" },
      ],
    });
    const second = safeParse(repair.text, zodSchema);
    if (!second.ok) throw new ProviderError(`Model output failed validation after one repair: ${second.error}`, "provider_malformed", true);
    return { value: second.value, usage: sumUsage(first.usage, repair.usage) };
  }

  async assessAnswer(input: AssessmentInput): Promise<{ output: AssessorOutput; meta: ProviderMeta }> {
    const { value, usage } = await this.structured(
      ASSESSOR_SYSTEM,
      assessorUserContent(input),
      assessorJsonSchema(input.rubric),
      looseAssessorOutputSchema,
      8000,
    );
    // Unknown/duplicate criterion ids and quote checks are enforced server-side by validateAssessorOutput.
    return { output: value, meta: { mode: "live", vendor: "anthropic", model: this.model, promptVersion: ASSESSOR_PROMPT_VERSION, usage } };
  }

  async generateCurriculum(input: CurriculumInput): Promise<{ draft: CurriculumDraft; meta: ProviderMeta }> {
    const { value, usage } = await this.structured(
      CURRICULUM_SYSTEM,
      curriculumUserContent(input),
      curriculumJsonSchema,
      curriculumDraftSchema,
      16000,
    );
    return { draft: value, meta: { mode: "live", vendor: "anthropic", model: this.model, promptVersion: CURRICULUM_PROMPT_VERSION, usage } };
  }

  async tutor(input: TutorInput): Promise<{ explanation: string; meta: ProviderMeta }> {
    const { text, usage } = await this.call({ system: TUTOR_SYSTEM, content: tutorUserContent(input), maxTokens: 4000 });
    const explanation = text.trim().slice(0, MAX_TUTOR_CHARS);
    if (!explanation) throw new ProviderError("Tutor returned no text.", "provider_malformed", true);
    return { explanation, meta: { mode: "live", vendor: "anthropic", model: this.model, promptVersion: TUTOR_PROMPT_VERSION, usage } };
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
