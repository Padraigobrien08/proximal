// AI-drafted assessment questions: wire contract, JSON schema and server-side validation. Pure (no SDK, DB or Next).
// A draft is never a question: it becomes one only when the owner approves it (services/questionDrafts.ts).
import { z } from "zod";
import { taskTypeSchema } from "../content/schemas";

export const DRAFTS_PER_SKILL = 2;
export const MAX_DRAFT_SOURCE_CHARS = 24_000;

const criterionIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, "criterion ids are short slugs (letters, digits, - and _)");

export const draftCriterionSchema = z.strictObject({
  id: criterionIdSchema,
  essential: z.boolean(),
  description: z.string().trim().min(1).max(500),
  acceptableEquivalents: z.array(z.string().trim().min(1).max(200)).max(10),
  fatalIfNotMet: z.boolean(),
});

export const draftExampleSchema = z.strictObject({
  label: z.enum(["correct", "partial", "wrong"]),
  answer: z.string().trim().min(1).max(4000),
  expectedOutcome: z.enum(["pass", "partial", "fail"]),
});

/** One proposed question as the model returns it (and as the owner edits it). */
export const draftQuestionSchema = z.strictObject({
  familyRole: z.enum(["initial", "new_context"]),
  /** For new_context: what changes structurally versus the initial question (not just new numbers). */
  transferChange: z.string().trim().max(400),
  taskType: taskTypeSchema,
  prompt: z.string().trim().min(1).max(2000),
  referenceSummary: z.string().trim().min(1).max(2000),
  criteria: z.array(draftCriterionSchema).min(1).max(8),
  numericChecks: z.array(z.strictObject({ criterionId: z.string(), value: z.number(), tolerance: z.number().positive() })).max(8),
  hints: z.array(z.string().trim().min(1).max(1000)).length(2),
  sourcePages: z.array(z.number().int().positive()).min(1).max(20),
  examples: z.array(draftExampleSchema).min(2).max(4),
});
export type DraftQuestion = z.infer<typeof draftQuestionSchema>;

/** Outer shape only; each question is validated separately by checkDraftBatch. */
export const looseDraftBatchSchema = z.strictObject({ questions: z.array(z.unknown()).max(4) });

/** Strict JSON schema for structured output (every property required, no extras). */
export const draftBatchJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "familyRole",
          "transferChange",
          "taskType",
          "prompt",
          "referenceSummary",
          "criteria",
          "numericChecks",
          "hints",
          "sourcePages",
          "examples",
        ],
        properties: {
          familyRole: { type: "string", enum: ["initial", "new_context"] },
          transferChange: { type: "string" },
          taskType: { type: "string", enum: ["explain", "calculate", "derive", "apply"] },
          prompt: { type: "string" },
          referenceSummary: { type: "string" },
          criteria: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "essential", "description", "acceptableEquivalents", "fatalIfNotMet"],
              properties: {
                id: { type: "string" },
                essential: { type: "boolean" },
                description: { type: "string" },
                acceptableEquivalents: { type: "array", items: { type: "string" } },
                fatalIfNotMet: { type: "boolean" },
              },
            },
          },
          numericChecks: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["criterionId", "value", "tolerance"],
              properties: { criterionId: { type: "string" }, value: { type: "number" }, tolerance: { type: "number" } },
            },
          },
          hints: { type: "array", items: { type: "string" } },
          sourcePages: { type: "array", items: { type: "integer" } },
          examples: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "answer", "expectedOutcome"],
              properties: {
                label: { type: "string", enum: ["correct", "partial", "wrong"] },
                answer: { type: "string" },
                expectedOutcome: { type: "string", enum: ["pass", "partial", "fail"] },
              },
            },
          },
        },
      },
    },
  },
};

/** Problems with one question beyond its schema. `allowedPages` are the unit's approved source pages. */
export function questionProblems(q: DraftQuestion, allowedPages: number[]): string[] {
  const problems: string[] = [];
  const ids = q.criteria.map((c) => c.id);
  if (new Set(ids).size !== ids.length) problems.push("criterion ids must be unique");
  if (!q.criteria.some((c) => c.essential)) problems.push("at least one criterion must be essential");
  for (const n of q.numericChecks) if (!ids.includes(n.criterionId)) problems.push(`numeric check refers to unknown criterion "${n.criterionId}"`);
  if (q.numericChecks.length > 0 && q.taskType === "explain") problems.push("numeric checks are only for calculation/application questions");
  const allowed = new Set(allowedPages);
  for (const p of q.sourcePages) if (!allowed.has(p)) problems.push(`cites page ${p}, which is not one of this subtopic's pages (${allowedPages.join(", ")})`);
  if (!q.examples.some((e) => e.label === "correct" && e.expectedOutcome === "pass")) problems.push("needs a correct example answer expected to pass");
  if (!q.examples.some((e) => e.label !== "correct")) problems.push("needs a partial or wrong example answer");
  for (const e of q.examples) {
    if (e.label === "correct" && e.expectedOutcome !== "pass") problems.push("a correct example must be expected to pass");
    if (e.label !== "correct" && e.expectedOutcome === "pass") problems.push(`a ${e.label} example cannot be expected to pass`);
  }
  if (q.familyRole === "new_context" && q.transferChange.trim().length < 10) problems.push("a new-context question must say what changes structurally");
  return problems;
}

export type CheckedDraft = { ok: true; question: DraftQuestion } | { ok: false; question: unknown; problems: string[] };

/**
 * A batch must hold exactly one initial and one new-context question with different prompts. Each question is
 * checked on its own so one bad question does not discard a good one.
 */
export function checkDraftBatch(raw: unknown, allowedPages: number[]): { drafts: CheckedDraft[]; batchProblems: string[] } {
  const batch = looseDraftBatchSchema.safeParse(raw);
  if (!batch.success) return { drafts: [], batchProblems: ["output was not a list of questions"] };
  const drafts: CheckedDraft[] = batch.data.questions.map((q) => {
    const parsed = draftQuestionSchema.safeParse(q);
    if (!parsed.success) return { ok: false, question: q, problems: parsed.error.issues.map((i) => `${i.path.join(".") || "question"}: ${i.message}`) };
    const problems = questionProblems(parsed.data, allowedPages);
    return problems.length ? { ok: false, question: parsed.data, problems } : { ok: true, question: parsed.data };
  });
  const batchProblems: string[] = [];
  const roles = drafts.flatMap((d) => (d.ok ? [d.question.familyRole] : []));
  if (drafts.length !== DRAFTS_PER_SKILL) batchProblems.push(`expected ${DRAFTS_PER_SKILL} questions, got ${drafts.length}`);
  if (roles.filter((r) => r === "initial").length > 1 || roles.filter((r) => r === "new_context").length > 1) {
    batchProblems.push("expected one initial and one new-context question");
  }
  const prompts = drafts.flatMap((d) => (d.ok ? [d.question.prompt.trim().toLowerCase()] : []));
  if (new Set(prompts).size !== prompts.length) batchProblems.push("the two questions have the same prompt");
  return { drafts, batchProblems };
}
