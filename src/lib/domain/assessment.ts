// Criterion validation and server-side outcome aggregation. The model never chooses outcomes.
import type {
  AssessorOutput,
  AttemptOutcome,
  CriterionJudgement,
  NumericCheck,
  Rubric,
  Validity,
} from "./types";

export const MAX_REASON_CHARS = 400;
export const MAX_QUOTE_CHARS = 600;
export const MAX_MISCONCEPTION_CHARS = 400;

export interface ValidationResult {
  validity: Validity;
  problems: string[];
}

/**
 * Validate assessor output against the frozen rubric and the exact submitted answer.
 * - exactly one judgement per rubric criterion, no unknown IDs
 * - every non-null answerQuote is an exact substring of the answer
 * - met/partial claims require a quote
 */
export function validateAssessorOutput(
  output: AssessorOutput,
  rubric: Rubric,
  answer: string,
): ValidationResult {
  const problems: string[] = [];
  const known = new Set(rubric.criteria.map((c) => c.id));
  const seen = new Set<string>();
  for (const j of output.criteria) {
    if (!known.has(j.criterionId)) problems.push(`unknown criterion id: ${j.criterionId}`);
    if (seen.has(j.criterionId)) problems.push(`duplicate criterion id: ${j.criterionId}`);
    seen.add(j.criterionId);
    if (j.answerQuote !== null) {
      if (j.answerQuote.length === 0 || !answer.includes(j.answerQuote)) {
        problems.push(`quote for ${j.criterionId} is not an exact excerpt of the answer`);
      }
      if (j.answerQuote.length > MAX_QUOTE_CHARS) problems.push(`quote for ${j.criterionId} too long`);
    } else if (j.status === "met" || j.status === "partial") {
      problems.push(`${j.status} judgement for ${j.criterionId} has no answer quote`);
    }
    if (j.briefReason.length > MAX_REASON_CHARS) problems.push(`reason for ${j.criterionId} too long`);
  }
  for (const id of known) if (!seen.has(id)) problems.push(`missing judgement for criterion ${id}`);
  if (output.possibleMisconception && output.possibleMisconception.length > MAX_MISCONCEPTION_CHARS) {
    problems.push("misconception text too long");
  }
  return { validity: problems.length === 0 ? "valid" : "invalid", problems };
}

const NUMBER_RE = /[-−–]?\s?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi;

/** Extract signed decimal numbers from free text (unicode minus treated as a sign). */
export function extractNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const raw = m[0].replace(/[−–]/g, "-").replace(/\s/g, "");
    const n = Number(raw);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/**
 * Objective numeric checks: a model "met" claim on a numeric criterion conflicts when no number in
 * the answer lies within tolerance. Only used for calculation objectives.
 */
export function numericConflicts(
  judgements: CriterionJudgement[],
  checks: NumericCheck[],
  answer: string,
): string[] {
  if (checks.length === 0) return [];
  const nums = extractNumbers(answer);
  const conflicts: string[] = [];
  for (const check of checks) {
    const j = judgements.find((x) => x.criterionId === check.criterionId);
    if (!j || j.status !== "met") continue;
    const ok = nums.some((n) => Math.abs(n - check.value) <= check.tolerance);
    if (!ok) conflicts.push(`model marked ${check.criterionId} met but no value within ±${check.tolerance} of ${check.value}`);
  }
  return conflicts;
}

export interface AggregateResult {
  outcome: AttemptOutcome;
  validity: Validity;
  problems: string[];
}

/**
 * Outcome aggregation:
 * - invalid output/evidence quote, or unresolved essential criterion -> uncertain
 * - conflict with objective deterministic check -> uncertain
 * - supported fatal-error finding (fatal criterion not_met) -> fail
 * - all essential met -> pass
 * - some essential met/partial -> partial
 * - none met -> fail
 */
export function aggregateOutcome(
  output: AssessorOutput,
  rubric: Rubric,
  answer: string,
  numericChecks: NumericCheck[] = [],
): AggregateResult {
  const v = validateAssessorOutput(output, rubric, answer);
  if (v.validity === "invalid") return { outcome: "uncertain", validity: "invalid", problems: v.problems };

  const byId = new Map(output.criteria.map((j) => [j.criterionId, j]));
  const essential = rubric.criteria.filter((c) => c.essential || c.fatalIfNotMet);

  if (essential.some((c) => byId.get(c.id)!.status === "uncertain")) {
    return { outcome: "uncertain", validity: "valid", problems: ["an essential criterion is unresolved"] };
  }
  const conflicts = numericConflicts(output.criteria, numericChecks, answer);
  if (conflicts.length > 0) return { outcome: "uncertain", validity: "valid", problems: conflicts };

  if (rubric.criteria.some((c) => c.fatalIfNotMet && byId.get(c.id)!.status === "not_met")) {
    return { outcome: "fail", validity: "valid", problems: [] };
  }
  const statuses = essential.map((c) => byId.get(c.id)!.status);
  if (statuses.every((s) => s === "met")) return { outcome: "pass", validity: "valid", problems: [] };
  if (statuses.some((s) => s === "met" || s === "partial")) return { outcome: "partial", validity: "valid", problems: [] };
  return { outcome: "fail", validity: "valid", problems: [] };
}

/** Normalisation used for exact matching of authored demo answers (mock mode only). */
export function normaliseAnswer(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[−–]/g, "-")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
