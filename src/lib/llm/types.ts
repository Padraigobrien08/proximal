// Provider contract. Implementations never write application state.
import type { AssessorOutput, NumericCheck, ProviderMode, Rubric, TaskType } from "../domain/types";

export interface AssessmentInput {
  questionId: string;
  taskType: TaskType;
  prompt: string;
  rubric: Rubric;
  reference: { summary: string; numericChecks: NumericCheck[] };
  /** Relevant approved source text, page-labelled. Untrusted data. */
  sourceText: string;
  /** Submitted answer. Untrusted data. */
  answer: string;
}

export interface CurriculumInput {
  sha256: string;
  fileName: string;
  pages: { page: number; text: string }[];
}

export interface CurriculumDraft {
  topics: {
    title: string;
    units: { title: string; objective: string; sourcePages: number[]; skills: { objective: string }[] }[];
  }[];
  suggestions: string[];
}

export interface TutorInput {
  objective: string;
  sourcePages: { page: number; text: string }[];
  /** Diagnosed criterion gap, if any. */
  gap: string | null;
  request: "explanation" | "worked_example";
}

export interface ChatInput {
  moduleTitle: string;
  question: string;
  /** Recent turns of this conversation, oldest first. Untrusted data. */
  history: { role: "user" | "assistant"; content: string }[];
  /** Retrieved lecture pages; `ref` is what the model cites. Untrusted data. */
  pages: { ref: number; sourceLabel: string; page: number; text: string }[];
}

export interface ChatReply {
  answer: string;
  /** Page refs the answer relies on (validated against the pages provided). */
  citedRefs: number[];
  /** False when the lecture pages do not cover the question and the answer is general knowledge. */
  coveredBySources: boolean;
}

export interface PacerClassifyInput {
  objectives: import("../pacer/validation").PacerObjectiveInput[];
}

export interface QuestionDraftInput {
  courseTitle: string;
  unitTitle: string;
  /** The skill objective the questions must assess. */
  objective: string;
  /** Approved source pages for the unit. Untrusted data. */
  sourcePages: { page: number; text: string }[];
}

export type LiveVendor = "anthropic" | "openai";

export interface ProviderMeta {
  mode: ProviderMode;
  /** Which live API produced the result; null for offline fixtures and rules. */
  vendor?: LiveVendor | null;
  model: string | null;
  promptVersion: string;
  usage: { inputTokens: number; outputTokens: number } | null;
}

export interface LearningProvider {
  readonly mode: "mock" | "live";
  readonly vendor?: LiveVendor | null;
  /** Assessment model (live) or null. */
  readonly model: string | null;
  /** Model per job (live only). */
  readonly models?: import("./jobs").JobModels;
  generateCurriculum(input: CurriculumInput): Promise<{ draft: CurriculumDraft; meta: ProviderMeta }>;
  assessAnswer(input: AssessmentInput): Promise<{ output: AssessorOutput; meta: ProviderMeta }>;
  tutor(input: TutorInput): Promise<{ explanation: string; meta: ProviderMeta }>;
  /** Lecture chat. Absent (or offline_unsupported) means retrieval-only answers. Metered as the tutor job. */
  chat?(input: ChatInput): Promise<{ reply: ChatReply; meta: ProviderMeta }>;
  /**
   * PACER classification proposals (one candidate per objective, unvalidated domain shape). Metered as the curriculum
   * job. The server validates ids, schema and quotes; the provider never writes state.
   */
  classifyPacer?(input: PacerClassifyInput): Promise<{ results: unknown[]; meta: ProviderMeta }>;
  /**
   * Draft assessment questions for one skill (unvalidated). Metered as the curriculum job. Drafts are stored for owner
   * review and never used in a check until approved.
   */
  draftQuestions?(input: QuestionDraftInput): Promise<{ batch: unknown; meta: ProviderMeta }>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: "provider_timeout" | "provider_unavailable" | "provider_malformed" | "provider_refusal" | "offline_unsupported",
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export const OFFLINE_ASSESS_MESSAGE = "Offline demo can assess the supplied example answers only.";
export const OFFLINE_CURRICULUM_MESSAGE = "Offline mode cannot generate a curriculum for this file.";
export const OFFLINE_CHAT_MESSAGE = "Offline mode has no AI chat. Showing the most relevant lecture pages instead.";
export const OFFLINE_PACER_MESSAGE = "Offline mode has authored classifications for the curated demo contexts only.";
export const OFFLINE_QUESTION_DRAFT_MESSAGE = "Offline mode can only prepare questions for the authored sample lecture.";
export const OFFLINE_TUTOR_MESSAGE = "Offline mode has no tutor. Only the checked fixture explanations are available.";
