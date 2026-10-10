// Strictly fixture-based offline provider. Never general AI grading.
import { normaliseAnswer } from "../domain/assessment";
import type { AssessorOutput } from "../domain/types";
import type { ExampleFixture } from "../content/schemas";
import {
  OFFLINE_ASSESS_MESSAGE,
  OFFLINE_CURRICULUM_MESSAGE,
  OFFLINE_TUTOR_MESSAGE,
  ProviderError,
  type AssessmentInput,
  type CurriculumDraft,
  type CurriculumInput,
  type LearningProvider,
  type ProviderMeta,
} from "./types";

export const MOCK_PROMPT_VERSION = "mock-fixture-v1";

export interface MockProviderDeps {
  /** Authored example answers for a question id. */
  examplesFor(questionId: string): ExampleFixture[];
  /** sha256 of the generated sample lecture and its fixture curriculum. */
  sampleLecture: { sha256: string; draft: CurriculumDraft } | null;
}

const meta: ProviderMeta = { mode: "mock", model: null, promptVersion: MOCK_PROMPT_VERSION, usage: null };

export class MockProvider implements LearningProvider {
  readonly mode = "mock" as const;
  readonly model = null;
  constructor(private deps: MockProviderDeps) {}

  async assessAnswer(input: AssessmentInput): Promise<{ output: AssessorOutput; meta: ProviderMeta }> {
    const target = normaliseAnswer(input.answer);
    const match = this.deps.examplesFor(input.questionId).find((e) => normaliseAnswer(e.answer) === target);
    if (match) {
      // Authored quotes are excerpts of the authored text; re-anchor them on the submitted answer's exact characters.
      return {
        output: {
          criteria: match.judgements.map((j) => ({ ...j, answerQuote: reanchor(j.answerQuote, input.answer) })),
          possibleMisconception: match.possibleMisconception,
        },
        meta,
      };
    }
    return {
      output: {
        criteria: input.rubric.criteria.map((c) => ({
          criterionId: c.id,
          status: "uncertain" as const,
          answerQuote: null,
          briefReason: OFFLINE_ASSESS_MESSAGE,
        })),
        possibleMisconception: null,
      },
      meta,
    };
  }

  async generateCurriculum(input: CurriculumInput): Promise<{ draft: CurriculumDraft; meta: ProviderMeta }> {
    if (this.deps.sampleLecture && input.sha256 === this.deps.sampleLecture.sha256) {
      return { draft: this.deps.sampleLecture.draft, meta };
    }
    throw new ProviderError(OFFLINE_CURRICULUM_MESSAGE, "offline_unsupported", false);
  }

  async tutor(): Promise<{ explanation: string; meta: ProviderMeta }> {
    throw new ProviderError(OFFLINE_TUTOR_MESSAGE, "offline_unsupported", false);
  }
}

/** Locate an authored quote in the submitted answer when only whitespace/case differs. */
function reanchor(quote: string | null, submitted: string): string | null {
  if (quote === null || submitted.includes(quote)) return quote;
  const pattern = quote
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[-−–]/g, "[-−–]"))
    .join("\\s+");
  const m = new RegExp(pattern, "i").exec(submitted);
  return m ? m[0] : quote;
}
