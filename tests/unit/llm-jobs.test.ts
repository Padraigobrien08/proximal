import { describe, expect, it } from "vitest";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { readEnv } from "../../src/lib/env";
import { JOB_LIMITS, type JobConfigs } from "../../src/lib/llm/jobs";
import { OpenAIProvider } from "../../src/lib/llm/openai";
import { ClaudeProvider } from "../../src/lib/llm/claude";
import type { AssessmentInput } from "../../src/lib/llm/types";

const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

describe("per-job model configuration", () => {
  it("uses the default model for every job unless a job override is set", () => {
    const e = readEnv(env({ LLM_MODE: "openai", OPENAI_API_KEY: "k", OPENAI_MODEL: "base", OPENAI_MODEL_TUTOR: "fast" }));
    expect(e.jobs).toEqual({
      assess: { model: "base", ...JOB_LIMITS.assess },
      curriculum: { model: "base", ...JOB_LIMITS.curriculum },
      tutor: { model: "fast", ...JOB_LIMITS.tutor },
    });
  });

  it("accepts per-job models without a default, but every job must resolve to a model", () => {
    const all = readEnv(
      env({ LLM_MODE: "openai", OPENAI_API_KEY: "k", OPENAI_MODEL_ASSESS: "a", OPENAI_MODEL_CURRICULUM: "c", OPENAI_MODEL_TUTOR: "t" }),
    );
    expect([all.jobs!.assess.model, all.jobs!.curriculum.model, all.jobs!.tutor.model]).toEqual(["a", "c", "t"]);
    expect(() => readEnv(env({ LLM_MODE: "openai", OPENAI_API_KEY: "k", OPENAI_MODEL_ASSESS: "a" }))).toThrow(
      /OPENAI_MODEL_CURRICULUM and OPENAI_MODEL_TUTOR/,
    );
    expect(() => readEnv(env({ LLM_MODE: "openai", OPENAI_API_KEY: "k" }))).toThrow(/requires OPENAI_MODEL/);
    expect(() => readEnv(env({ LLM_MODE: "openai", OPENAI_MODEL: "m" }))).toThrow(/requires OPENAI_API_KEY/);
  });

  it("validates optional per-job effort against the selected vendor", () => {
    const ok = readEnv(env({ LLM_MODE: "openai", OPENAI_API_KEY: "k", OPENAI_MODEL: "m", OPENAI_EFFORT_ASSESS: "high" }));
    expect(ok.jobs!.assess.effort).toBe("high");
    expect(ok.jobs!.tutor.effort).toBeUndefined();
    expect(() => readEnv(env({ LLM_MODE: "openai", OPENAI_API_KEY: "k", OPENAI_MODEL: "m", OPENAI_EFFORT_TUTOR: "huge" }))).toThrow(
      /OPENAI_EFFORT_TUTOR must be one of/,
    );
    // "minimal" is an OpenAI level, not an Anthropic one.
    expect(() => readEnv(env({ LLM_MODE: "anthropic", ANTHROPIC_API_KEY: "k", ANTHROPIC_MODEL: "m", ANTHROPIC_EFFORT_ASSESS: "minimal" }))).toThrow(
      /ANTHROPIC_EFFORT_ASSESS/,
    );
  });

  it("mock mode needs no models", () => {
    expect(readEnv(env({})).jobs).toBeNull();
  });
});

const jobs: JobConfigs = {
  assess: { model: "grader", effort: "high", ...JOB_LIMITS.assess },
  curriculum: { model: "planner", ...JOB_LIMITS.curriculum },
  tutor: { model: "explainer", effort: "low", ...JOB_LIMITS.tutor },
};

const assessInput: AssessmentInput = {
  questionId: "q",
  taskType: "explain",
  prompt: "p",
  rubric: { version: 1, criteria: [{ id: "c1", essential: true, description: "d", acceptableEquivalents: [], fatalIfNotMet: false }] },
  reference: { summary: "r", numericChecks: [] },
  sourceText: "",
  answer: "an answer",
};
const graded = JSON.stringify({ criteria: [{ criterionId: "c1", status: "met", answerQuote: "an answer", briefReason: "ok" }], possibleMisconception: null });
const drafted = JSON.stringify({
  topics: [
    {
      title: "T",
      units: [1, 2, 3].map((i) => ({ title: `U${i}`, objective: `O${i}`, sourcePages: [1], skills: [{ objective: `S${i}` }] })),
    },
  ],
  suggestions: [],
});

describe("OpenAI adapter routes each job to its own model and limits", () => {
  it("sends model, output limit, timeout and effort per job, and records the model that ran", async () => {
    const calls: { params: Record<string, unknown>; options: { timeout?: number } }[] = [];
    const reply = (text: string) =>
      ({
        status: "completed",
        error: null,
        incomplete_details: null,
        output: [{ type: "message", content: [{ type: "output_text", text, annotations: [] }] }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }) as unknown as OpenAI.Responses.Response;
    const replies = [reply(graded), reply(drafted), reply("An explanation.")];
    const client = {
      responses: {
        create: async (params: Record<string, unknown>, options: { timeout?: number }) => {
          calls.push({ params, options });
          return replies.shift();
        },
      },
    } as unknown as Pick<OpenAI, "responses">;
    const p = new OpenAIProvider({ apiKey: "k", jobs, client });
    expect(p.model).toBe("grader");
    expect(p.models).toEqual({ assess: "grader", curriculum: "planner", tutor: "explainer" });

    const a = await p.assessAnswer(assessInput);
    const c = await p.generateCurriculum({ sha256: "x", fileName: "f.pdf", pages: [{ page: 1, text: "t" }] });
    const t = await p.tutor({ objective: "o", sourcePages: [], gap: null, request: "explanation" });

    expect(calls.map((x) => [x.params.model, x.params.max_output_tokens, x.options.timeout, x.params.reasoning ?? null])).toEqual([
      ["grader", JOB_LIMITS.assess.maxOutputTokens, JOB_LIMITS.assess.timeoutMs, { effort: "high" }],
      ["planner", JOB_LIMITS.curriculum.maxOutputTokens, JOB_LIMITS.curriculum.timeoutMs, null],
      ["explainer", JOB_LIMITS.tutor.maxOutputTokens, JOB_LIMITS.tutor.timeoutMs, { effort: "low" }],
    ]);
    expect([a.meta.model, c.meta.model, t.meta.model]).toEqual(["grader", "planner", "explainer"]);
  });
});

describe("Claude adapter routes each job to its own model and limits", () => {
  it("sends model, max_tokens, timeout and effort per job, combining effort with the output format", async () => {
    const calls: { params: Record<string, unknown>; options: { timeout?: number } }[] = [];
    const reply = (text: string) =>
      ({
        content: [{ type: "text", text, citations: null }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }) as unknown as Anthropic.Message;
    const replies = [reply(graded), reply("An explanation.")];
    const client = {
      messages: {
        create: async (params: Record<string, unknown>, options: { timeout?: number }) => {
          calls.push({ params, options });
          return replies.shift();
        },
      },
    } as unknown as Pick<Anthropic, "messages">;
    const p = new ClaudeProvider({ apiKey: "k", jobs, client });
    const a = await p.assessAnswer(assessInput);
    const t = await p.tutor({ objective: "o", sourcePages: [], gap: null, request: "explanation" });

    expect(calls[0].params).toMatchObject({
      model: "grader",
      max_tokens: JOB_LIMITS.assess.maxOutputTokens,
      output_config: { format: { type: "json_schema" }, effort: "high" },
    });
    expect(calls[0].options.timeout).toBe(JOB_LIMITS.assess.timeoutMs);
    expect(calls[1].params).toMatchObject({ model: "explainer", output_config: { effort: "low" } });
    expect(calls[1].params.output_config).not.toHaveProperty("format");
    expect([a.meta.model, t.meta.model]).toEqual(["grader", "explainer"]);
  });
});
