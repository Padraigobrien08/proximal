"use client";

import { Pill } from "./ui";

export interface FeedbackData {
  assessmentId: string;
  outcome: "pass" | "partial" | "fail" | "uncertain";
  providerMode: string;
  providerModel: string | null;
  validity: string;
  excluded: boolean;
  excludedReason?: string | null;
  problems: string[];
  criteria: {
    criterionId: string;
    description: string;
    essential: boolean;
    fatalIfNotMet: boolean;
    status: string;
    answerQuote: string | null;
    briefReason: string;
  }[];
  possibleMisconception: string | null;
  referenceSummary: string;
}

const STATUS_TEXT: Record<string, string> = { met: "Met", partial: "Partly met", not_met: "Not met", uncertain: "Uncertain" };
const STATUS_TONE: Record<string, "good" | "warn" | "neutral" | "info"> = {
  met: "good",
  partial: "warn",
  not_met: "warn",
  uncertain: "neutral",
};

export const OUTCOME_TEXT: Record<FeedbackData["outcome"], string> = {
  pass: "All essential criteria met",
  partial: "Some essential criteria met",
  fail: "Essential criteria not met",
  uncertain: "Not enough evidence to judge this answer",
};

export function providerLabel(f: Pick<FeedbackData, "providerMode" | "providerModel">): string {
  if (f.providerMode === "mock") return "Judged against offline demo fixtures";
  if (f.providerMode === "rule") return "Recorded as an explicit “I don’t know”";
  return `Judged by Claude (${f.providerModel ?? "configured model"})`;
}

/** Released criterion-by-criterion feedback for one assessed answer. */
export function CriterionFeedback({ feedback, showReference = true }: { feedback: FeedbackData; showReference?: boolean }) {
  return (
    <div className="space-y-2" data-testid="feedback">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={feedback.outcome === "pass" ? "good" : feedback.outcome === "uncertain" ? "neutral" : "warn"}>{OUTCOME_TEXT[feedback.outcome]}</Pill>
        <span className="text-xs text-muted">{providerLabel(feedback)}</span>
      </div>
      {feedback.excluded && (
        <p className="rounded-md bg-amber-soft px-3 py-2 text-xs text-amber-ink">
          This judgement is excluded from your learning record{feedback.excludedReason ? ` (${feedback.excludedReason})` : ""}.
        </p>
      )}
      {feedback.validity === "invalid" && (
        <p className="rounded-md bg-amber-soft px-3 py-2 text-xs text-amber-ink">
          The judgement failed server-side checks, so it has no effect on your evidence.
        </p>
      )}
      {feedback.outcome === "uncertain" && feedback.validity !== "invalid" && (
        <p className="text-xs text-muted">No evidence was recorded from this answer. You can try a fresh question or flag the judgement.</p>
      )}
      <ul className="space-y-1.5">
        {feedback.criteria.map((c) => (
          <li key={c.criterionId} className="rounded-md bg-paper px-3 py-2 text-sm">
            <p className="flex flex-wrap items-baseline gap-2">
              <Pill tone={STATUS_TONE[c.status] ?? "neutral"}>{STATUS_TEXT[c.status] ?? c.status}</Pill>
              <span>
                {c.description}
                {c.essential ? "" : " (optional)"}
              </span>
            </p>
            <p className="mt-1 text-xs text-muted">{c.briefReason}</p>
            <p className="mt-0.5 text-xs text-muted">
              From your answer: {c.answerQuote ? <q className="italic">{c.answerQuote}</q> : "Not stated"}
            </p>
          </li>
        ))}
      </ul>
      {feedback.possibleMisconception && (
        <p className="text-sm">
          <strong className="font-medium">Possible misconception:</strong> {feedback.possibleMisconception}
        </p>
      )}
      {showReference && (
        <details className="text-sm">
          <summary className="inline-flex min-h-9 items-center text-teal">Reference answer</summary>
          <p className="mt-1 text-muted">{feedback.referenceSummary}</p>
        </details>
      )}
    </div>
  );
}
