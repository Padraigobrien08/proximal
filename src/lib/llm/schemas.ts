// Zod schemas + JSON schemas for model output. Model output is always validated with Zod.
import { z } from "zod";
import type { Rubric } from "../domain/types";

export const MAX_ANSWER_CHARS = 4000;

export function assessorOutputSchema(criterionIds: string[]) {
  return z.strictObject({
    criteria: z
      .array(
        z.strictObject({
          criterionId: z.enum(criterionIds as [string, ...string[]]),
          status: z.enum(["met", "partial", "not_met", "uncertain"]),
          answerQuote: z.string().max(600).nullable(),
          briefReason: z.string().max(400),
        }),
      )
      .max(criterionIds.length),
    possibleMisconception: z.string().max(400).nullable(),
  });
}

/** Loose schema used to inspect output before criterion-id checks (to report unknown ids honestly). */
export const looseAssessorOutputSchema = z.strictObject({
  criteria: z
    .array(
      z.strictObject({
        criterionId: z.string().max(64),
        status: z.enum(["met", "partial", "not_met", "uncertain"]),
        answerQuote: z.string().max(600).nullable(),
        briefReason: z.string().max(400),
      }),
    )
    .max(16),
  possibleMisconception: z.string().max(400).nullable(),
});

export function assessorJsonSchema(rubric: Rubric): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["criteria", "possibleMisconception"],
    properties: {
      criteria: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["criterionId", "status", "answerQuote", "briefReason"],
          properties: {
            criterionId: { type: "string", enum: rubric.criteria.map((c) => c.id) },
            status: { type: "string", enum: ["met", "partial", "not_met", "uncertain"] },
            answerQuote: { anyOf: [{ type: "string" }, { type: "null" }] },
            briefReason: { type: "string" },
          },
        },
      },
      possibleMisconception: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
  };
}

export const curriculumDraftSchema = z.strictObject({
  topics: z
    .array(
      z.strictObject({
        title: z.string().min(1).max(200),
        units: z
          .array(
            z.strictObject({
              title: z.string().min(1).max(200),
              objective: z.string().min(1).max(300),
              sourcePages: z.array(z.number().int().positive()).min(1).max(20),
              skills: z.array(z.strictObject({ objective: z.string().min(1).max(300) })).min(1).max(3),
            }),
          )
          .min(1),
      }),
    )
    .min(1)
    .max(8),
  suggestions: z.array(z.string().max(300)).max(10),
});

export const curriculumJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["topics", "suggestions"],
  properties: {
    topics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "units"],
        properties: {
          title: { type: "string" },
          units: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["title", "objective", "sourcePages", "skills"],
              properties: {
                title: { type: "string" },
                objective: { type: "string" },
                sourcePages: { type: "array", items: { type: "integer" } },
                skills: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["objective"],
                    properties: { objective: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
    },
    suggestions: { type: "array", items: { type: "string" } },
  },
};

/** Units must total 3-8 with valid page references. */
export function validateCurriculumDraft(
  draft: z.infer<typeof curriculumDraftSchema>,
  pageCount: number,
): string[] {
  const problems: string[] = [];
  const units = draft.topics.flatMap((t) => t.units);
  if (units.length < 3 || units.length > 8) problems.push(`expected 3-8 units, got ${units.length}`);
  for (const u of units) {
    for (const p of u.sourcePages) if (p < 1 || p > pageCount) problems.push(`unit "${u.title}" cites invalid page ${p}`);
    if (!u.objective.trim()) problems.push(`unit "${u.title}" has an empty objective`);
  }
  return problems;
}

export const MAX_CHAT_QUESTION_CHARS = 2000;
export const MAX_CHAT_ANSWER_CHARS = 4000;

export const chatReplySchema = z.strictObject({
  answer: z.string().min(1).max(MAX_CHAT_ANSWER_CHARS),
  citedRefs: z.array(z.number().int().min(1)).max(20),
  coveredBySources: z.boolean(),
});

export const chatJsonSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    answer: { type: "string" },
    citedRefs: { type: "array", items: { type: "integer" } },
    coveredBySources: { type: "boolean" },
  },
  required: ["answer", "citedRefs", "coveredBySources"],
  additionalProperties: false,
};
