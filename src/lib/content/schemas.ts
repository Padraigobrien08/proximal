// Zod schemas for authored content fixtures and owner-authored question banks.
import { z } from "zod";

export const taskTypeSchema = z.enum(["explain", "calculate", "derive", "apply"]);
export const criterionStatusSchema = z.enum(["met", "partial", "not_met", "uncertain"]);
export const outcomeSchema = z.enum(["pass", "partial", "fail", "uncertain"]);
export const questionStatusSchema = z.enum(["authored_fixture", "owner_reviewed", "excluded"]);

export const rubricCriterionSchema = z.strictObject({
  id: z.string().min(1).max(64),
  essential: z.boolean(),
  description: z.string().min(1).max(500),
  acceptableEquivalents: z.array(z.string().max(200)).max(10),
  fatalIfNotMet: z.boolean(),
});

export const rubricSchema = z.strictObject({
  version: z.number().int().positive(),
  criteria: z.array(rubricCriterionSchema).min(1).max(8),
});

export const numericCheckSchema = z.strictObject({
  criterionId: z.string(),
  value: z.number(),
  tolerance: z.number().positive(),
});

export const referenceSchema = z.strictObject({
  summary: z.string().min(1).max(2000),
  numericChecks: z.array(numericCheckSchema),
});

export const judgementSchema = z.strictObject({
  criterionId: z.string(),
  status: criterionStatusSchema,
  answerQuote: z.string().nullable(),
  briefReason: z.string().max(400),
});

export const exampleSchema = z.strictObject({
  label: z.enum(["correct", "partial", "wrong", "ambiguous"]),
  answer: z.string().min(1).max(4000),
  expectedOutcome: outcomeSchema,
  judgements: z.array(judgementSchema),
  possibleMisconception: z.string().nullable(),
});

export const questionFixtureSchema = z
  .strictObject({
    id: z.string().min(1).max(64),
    skillId: z.string().min(1),
    version: z.number().int().positive(),
    familyId: z.string().min(1),
    isTransfer: z.boolean(),
    taskType: taskTypeSchema,
    prompt: z.string().min(1).max(2000),
    reference: referenceSchema,
    rubric: rubricSchema,
    hints: z.array(z.string().min(1).max(1000)).length(2),
    sourceRefs: z.array(z.strictObject({ page: z.number().int().positive() })).min(1),
    revealSkillIds: z.array(z.string()).min(1),
    status: questionStatusSchema,
    examples: z.array(exampleSchema).default([]),
  })
  .superRefine((q, ctx) => {
    const ids = new Set(q.rubric.criteria.map((c) => c.id));
    if (ids.size !== q.rubric.criteria.length) ctx.addIssue({ code: "custom", message: `${q.id}: duplicate criterion ids` });
    for (const check of q.reference.numericChecks) {
      if (!ids.has(check.criterionId)) ctx.addIssue({ code: "custom", message: `${q.id}: numeric check for unknown criterion` });
    }
    if (q.reference.numericChecks.length > 0 && q.taskType === "explain") {
      ctx.addIssue({ code: "custom", message: `${q.id}: numeric checks are only for calculation/application objectives` });
    }
    if (!q.revealSkillIds.includes(q.skillId)) {
      ctx.addIssue({ code: "custom", message: `${q.id}: revealSkillIds must include the primary skill` });
    }
  });

export const questionBankSchema = z.strictObject({
  bankId: z.string(),
  note: z.string().optional(),
  questions: z.array(questionFixtureSchema).min(1),
});

export const skillFixtureSchema = z.strictObject({
  id: z.string(),
  objective: z.string().min(1).max(300),
  required: z.boolean(),
  transferRequired: z.boolean(),
});

export const unitFixtureSchema = z.strictObject({
  id: z.string(),
  title: z.string().min(1).max(200),
  objective: z.string().min(1).max(300),
  sourcePages: z.array(z.number().int().positive()).min(1),
  explanation: z.string().min(1),
  workedExample: z.string().min(1),
  skills: z.array(skillFixtureSchema).min(1).max(3),
});

export const curriculumFixtureSchema = z.strictObject({
  course: z.strictObject({ id: z.string(), title: z.string() }),
  topics: z
    .array(
      z.strictObject({
        id: z.string(),
        title: z.string(),
        position: z.number().int(),
        units: z.array(unitFixtureSchema).min(1),
      }),
    )
    .min(1),
});

export const lectureFixtureSchema = z.strictObject({
  title: z.string(),
  label: z.string(),
  fileName: z.string(),
  notice: z.string(),
  pages: z
    .array(
      z.strictObject({
        page: z.number().int().positive(),
        heading: z.string(),
        paragraphs: z.array(z.string()).min(1),
      }),
    )
    .length(6),
});

export const replayFixtureSchema = z.strictObject({
  label: z.literal("Seeded example — not participant data"),
  description: z.string(),
  startAt: z.string(),
  events: z.array(
    z.strictObject({
      day: z.number().nonnegative(),
      hour: z.number().min(0).max(23),
      sessionKey: z.string(),
      mode: z.enum(["learn", "review"]),
      phase: z.enum(["original", "repair"]),
      questionId: z.string(),
      exposedBeforeSubmission: z.boolean(),
      outcome: outcomeSchema,
      note: z.string(),
    }),
  ),
});

export type QuestionFixture = z.infer<typeof questionFixtureSchema>;
export type QuestionBank = z.infer<typeof questionBankSchema>;
export type CurriculumFixture = z.infer<typeof curriculumFixtureSchema>;
export type UnitFixture = z.infer<typeof unitFixtureSchema>;
export type LectureFixture = z.infer<typeof lectureFixtureSchema>;
export type ReplayFixture = z.infer<typeof replayFixtureSchema>;
export type ExampleFixture = z.infer<typeof exampleSchema>;
