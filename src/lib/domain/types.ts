// Shared domain types. Pure: no Next.js, SQLite or model SDK imports.

export type SessionMode = "learn" | "review";
export type TaskType = "explain" | "calculate" | "derive" | "apply";
export type CriterionStatus = "met" | "partial" | "not_met" | "uncertain";
export type AttemptOutcome = "pass" | "partial" | "fail" | "uncertain";
export type EvidenceState =
  | "unassessed"
  | "developing"
  | "supported"
  | "demonstrated_once"
  | "retention_demonstrated";
export type ExposureKind =
  | "explanation"
  | "feedback"
  | "hint"
  | "source"
  | "solution"
  | "external_assistance";
export type QuestionStatus = "authored_fixture" | "owner_reviewed" | "excluded";
export type AttemptPhase = "original" | "repair";
export type AttemptStatus = "pending" | "assessing" | "assessed" | "provider_error";
export type ProviderMode = "mock" | "live" | "rule";
export type Validity = "valid" | "invalid";

export const MS_HOUR = 60 * 60 * 1000;
export const MS_DAY = 24 * MS_HOUR;

export interface QuestionPublic {
  id: string;
  skillId: string;
  taskType: TaskType;
  prompt: string;
}

export interface RubricCriterion {
  id: string;
  essential: boolean;
  description: string;
  acceptableEquivalents: string[];
  /** Positively stated correctness condition: not_met means the disqualifying error occurred. */
  fatalIfNotMet: boolean;
}

export interface Rubric {
  version: number;
  criteria: RubricCriterion[];
}

/** Objective check used only for calculation objectives. */
export interface NumericCheck {
  criterionId: string;
  value: number;
  tolerance: number;
}

export interface ReferenceAnswer {
  summary: string;
  numericChecks: NumericCheck[];
}

/**
 * A citation: a page of one of the course's sources. `sourceId` is always written now; it is absent only on citations
 * recorded before migration 015 (frozen session snapshots) and in authored fixtures. Resolve citations with
 * pagesForRefs, which maps a missing sourceId to the course's oldest source (the one such a citation meant).
 */
export interface SourceRef {
  sourceId?: string;
  page: number;
}

export interface CriterionJudgement {
  criterionId: string;
  status: CriterionStatus;
  answerQuote: string | null;
  briefReason: string;
}

export interface AssessorOutput {
  criteria: CriterionJudgement[];
  possibleMisconception: string | null;
}

/** Full private question record. Never sent to the browser before release. */
export interface QuestionPrivate extends QuestionPublic {
  version: number;
  familyId: string;
  isTransfer: boolean;
  reference: ReferenceAnswer;
  rubric: Rubric;
  hints: string[];
  sourceRefs: SourceRef[];
  revealSkillIds: string[];
  status: QuestionStatus;
}

/** One effective attempt as seen by the evidence reducer. */
export interface EvidenceAttempt {
  attemptId: string;
  sessionId: string;
  submittedAt: number;
  recordOrder: number;
  mode: SessionMode;
  phase: AttemptPhase;
  /** Frozen at submission: a relevant hint/source/solution/feedback/explanation/external exposure preceded it. */
  exposedBeforeSubmission: boolean;
  declaredAssistance: boolean;
  outcome: AttemptOutcome | null; // null = pending / no final assessment
  validity: Validity | null;
  excluded: boolean;
  familyId: string;
  isTransfer: boolean;
}

export interface PassRecord {
  attemptId: string;
  sessionId: string;
  submittedAt: number;
  familyId: string;
  isTransfer: boolean;
}

export interface SkillReviewState {
  evidenceState: EvidenceState;
  epoch: number;
  stage: number | null;
  dueAt: number | null;
  lastPassAt: number | null;
  reassessmentNeeded: boolean;
  /** Independent passes in the current epoch. */
  currentEpochPasses: PassRecord[];
  transferCovered: boolean;
  lastIndependentAt: number | null;
  lastIndependentOutcome: AttemptOutcome | null;
  policyId: "heuristic-v1";
}
