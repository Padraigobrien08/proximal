"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useApiResource } from "../useApiResource";
import type { EvidenceState } from "@/lib/domain/types";
import { api, ApiError } from "../api";
import { EvidenceLabel } from "../EvidenceLabel";
import { MathText } from "../MathText";
import { ProviderBadge, type ProviderInfo } from "../ProviderBadge";
import { Button, ButtonLink, Card, Loading, Notice, Pill, newSubmissionKey } from "../ui";

interface Feedback {
  assessmentId: string;
  outcome: "pass" | "partial" | "fail" | "uncertain";
  providerMode: string;
  providerModel: string | null;
  validity: string;
  excluded: boolean;
  problems: string[];
  criteria: { criterionId: string; description: string; essential: boolean; fatalIfNotMet: boolean; status: string; answerQuote: string | null; briefReason: string }[];
  possibleMisconception: string | null;
  referenceSummary: string;
}

interface Attempt {
  id: string;
  phase: "original" | "repair";
  status: "pending" | "assessing" | "assessed" | "provider_error";
  answer: string;
  dontKnow: boolean;
  declaredAssistance: boolean;
  submittedAt: number;
  supportedOnly: boolean;
  lastError: string | null;
  feedbackWithheld: boolean;
  feedback: Feedback | null;
}

interface Item {
  sessionQuestionId: string;
  ordinal: number;
  repeatedFamily: boolean;
  questionStatus: string;
  question: { id: string; skillId: string; taskType: string; prompt: string };
  skill: { id: string; objective: string };
  unit: { id: string; title: string; objective: string };
  hintCount: number;
  revealedHints: { index: number; text: string }[];
  revealedSolution: string | null;
  attempts: Attempt[];
  answered: boolean;
  offerAlternatives: boolean;
}

interface SessionData {
  session: { id: string; mode: "learn" | "review"; phase: "checkpoint" | "results" | "repair" | "learning"; status: "active" | "ended"; isDemo: boolean };
  topic: { id: string; title: string };
  course: { id: string; title: string; isDemo: boolean };
  provider: ProviderInfo;
  progress: { total: number; answered: number; currentOrdinal: number | null };
  current: Item | null;
  items: Item[] | { ordinal: number; skillObjective: string; answered: boolean; skipped: boolean }[];
  results: null | {
    allAssessed: boolean;
    pendingAttemptIds: string[];
    feedbackReleased: boolean;
    skills: {
      skillId: string;
      objective: string;
      taskType: string;
      answered: boolean;
      originalOutcome: string | null;
      originalIndependent: boolean;
      evidenceState: EvidenceState;
      reassessmentNeeded: boolean;
      transferCovered: boolean;
      dueLabel: string;
    }[];
  };
  explanations: Record<string, { unitTitle: string; explanation: string; workedExample: string | null }>;
  units: { unitId: string; title: string; objective: string }[];
  noQuestionsAvailable: boolean;
  demoExamples: Record<string, { label: string; answer: string }[]>;
}

const STATUS_TEXT: Record<string, string> = { met: "Met", partial: "Partly met", not_met: "Not met", uncertain: "Uncertain" };
const OUTCOME_TEXT: Record<string, string> = {
  pass: "All essential criteria met",
  partial: "Some essential criteria met",
  fail: "Essential criteria not met",
  uncertain: "Uncertain – no effect on evidence",
};

function isFullItems(items: SessionData["items"]): items is Item[] {
  return items.length === 0 || "sessionQuestionId" in items[0];
}

export function SessionScreen({ sessionId }: { sessionId: string }) {
  const { data, error, reload: load, setData } = useApiResource<SessionData>(`/api/sessions/${sessionId}`);
  const [flash, setFlash] = useState<{ tone: "good" | "info" | "error" | "warn"; text: string } | null>(null);

  // Poll while an assessment is in flight (never re-calls the provider for assessed attempts).
  const inFlight =
    !!data &&
    ((data.results && !data.results.allAssessed) ||
      (isFullItems(data.items) && data.items.some((i) => i.attempts.some((a) => a.status === "assessing"))));
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [inFlight, load]);

  async function end(scope: "checkpoint" | "session") {
    try {
      setData({ ...(await api<SessionData>(`/api/sessions/${sessionId}/end`, { method: "POST", json: { scope } })), demoExamples: {} });
      setFlash({ tone: "info", text: scope === "checkpoint" ? "Checkpoint ended. Unanswered questions stay unassessed." : "Session ended. Completed attempts are kept." });
    } catch (err) {
      setFlash({ tone: "error", text: err instanceof ApiError ? err.message : "Could not end the session." });
    }
  }

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!data) return <Loading />;

  const { session } = data;
  const review = session.mode === "review";
  const modeLabel = review ? "Independent review checkpoint" : "Learning session";

  return (
    <div className="space-y-6">
      <ProviderBadge provider={data.provider} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href={`/topics/${data.topic.id}`} className="text-sm text-teal hover:underline">
            ← {data.topic.title}
          </Link>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <h1 className="font-serif text-2xl font-semibold">{modeLabel}</h1>
            <Pill tone={review ? "teal" : "info"}>{review ? "Review mode" : "Learning mode"}</Pill>
            {session.status === "ended" && <Pill>Ended</Pill>}
            {data.course.isDemo && <Pill tone="warn">Demo</Pill>}
          </div>
          <p className="text-sm text-muted" data-testid="progress">
            {review
              ? `Question ${Math.min(data.progress.answered + (data.current ? 1 : 0), data.progress.total)} of ${data.progress.total} · ${data.progress.answered} answered`
              : `${data.progress.total} practice question(s)`}
          </p>
        </div>
        {session.status === "active" && (
          <div className="flex gap-2">
            {review && session.phase === "checkpoint" && (
              <Button variant="secondary" onClick={() => end("checkpoint")}>
                End checkpoint early
              </Button>
            )}
            <Button variant="secondary" onClick={() => end("session")} data-testid="end-session">
              End session
            </Button>
          </div>
        )}
      </div>

      {flash && <Notice tone={flash.tone}>{flash.text}</Notice>}

      {review && session.phase === "checkpoint" && data.current && (
        <>
          <Notice>
            Closed-book check: feedback is held back until every answer is saved, so early feedback cannot teach later answers. Help is
            available, but using it makes that answer <strong>supported</strong> rather than independent.
          </Notice>
          <QuestionCard
            key={data.current.sessionQuestionId}
            sessionId={sessionId}
            item={data.current}
            mode="checkpoint"
            demoExamples={data.demoExamples[data.current.question.id] ?? []}
            onSubmitted={(msg) => {
              setFlash({ tone: "good", text: msg });
              load();
            }}
            onChanged={load}
          />
        </>
      )}

      {review && data.results && (
        <ResultsPanel
          sessionId={sessionId}
          data={data}
          onChanged={(msg) => {
            if (msg) setFlash({ tone: "info", text: msg });
            load();
          }}
        />
      )}

      {review && session.phase === "repair" && isFullItems(data.items) && session.status === "active" && (
        <section className="space-y-4" aria-labelledby="repair">
          <h2 id="repair" className="font-serif text-xl font-semibold">
            Correct an answer (supported practice)
          </h2>
          <p className="text-sm text-muted">
            A corrected answer is saved as a new practice attempt. Your original answer and its result are kept, and a correction cannot
            restore independent evidence.
          </p>
          {data.items
            .filter((i) => i.answered)
            .map((i) => (
              <QuestionCard
                key={i.sessionQuestionId}
                sessionId={sessionId}
                item={i}
                mode="repair"
                demoExamples={data.demoExamples[i.question.id] ?? []}
                onSubmitted={(msg) => {
                  setFlash({ tone: "good", text: msg });
                  load();
                }}
                onChanged={load}
              />
            ))}
        </section>
      )}

      {!review && <LearnFlow sessionId={sessionId} data={data} onChanged={load} setFlash={setFlash} />}

      {session.status === "ended" && (
        <Card>
          <p className="text-sm">This session has ended. Completed attempts and their evidence are saved.</p>
          <div className="mt-3 flex gap-2">
            <ButtonLink href={`/topics/${data.topic.id}`}>Back to topic</ButtonLink>
            <ButtonLink href="/" variant="secondary">
              Home
            </ButtonLink>
          </div>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- question card

function QuestionCard({
  sessionId,
  item,
  mode,
  demoExamples,
  onSubmitted,
  onChanged,
}: {
  sessionId: string;
  item: Item;
  mode: "checkpoint" | "repair" | "learn";
  demoExamples: { label: string; answer: string }[];
  onSubmitted: (message: string) => void;
  onChanged: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const [confidence, setConfidence] = useState<"" | "low" | "medium" | "high">("");
  const [declared, setDeclared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [plain, setPlain] = useState(false);
  const [sourcePages, setSourcePages] = useState<{ label: string; page: number; text: string }[] | null>(null);
  const keyRef = useRef(newSubmissionKey());

  async function submit(dontKnow = false) {
    setBusy(true);
    setErr(null);
    try {
      const res = await api<{ result: { message: string; assessment: { status: string; message?: string } | null } }>(
        `/api/sessions/${sessionId}/answers`,
        {
          method: "POST",
          json: {
            sessionQuestionId: item.sessionQuestionId,
            submissionKey: keyRef.current,
            answer: dontKnow ? "" : answer,
            dontKnow,
            confidence: confidence || null,
            declaredAssistance: declared,
          },
        },
      );
      keyRef.current = newSubmissionKey();
      setAnswer("");
      const providerErr = res.result.assessment?.status === "provider_error" ? ` (assessment failed: ${res.result.assessment.message}; you can retry later)` : "";
      onSubmitted(res.result.message + providerErr);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not save your answer. It has not been lost; try again.");
    } finally {
      setBusy(false);
    }
  }

  async function revealHelp(kind: "hint" | "source" | "solution", hintIndex?: number) {
    setErr(null);
    try {
      const res = await api<{ content: { pages?: { label: string; page: number; text: string }[] } }>(`/api/sessions/${sessionId}/reveal`, {
        method: "POST",
        json: { kind, sessionQuestionId: item.sessionQuestionId, hintIndex },
      });
      if (kind === "source") setSourcePages(res.content.pages ?? []);
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Help is unavailable right now.");
    }
  }

  const latest = item.attempts[item.attempts.length - 1];
  const nextHint = item.revealedHints.length;
  const helpUsed = item.revealedHints.length > 0 || item.revealedSolution !== null || sourcePages !== null;

  return (
    <Card className="space-y-4" >
      <div data-testid="question-card" data-question-id={item.question.id}>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>{item.unit.title}</span>
          <span>·</span>
          <span>Skill: {item.skill.objective}</span>
          {item.repeatedFamily && <Pill tone="warn">Repeated question family</Pill>}
          {item.questionStatus === "authored_fixture" && <Pill>Authored fixture</Pill>}
        </div>
        <p className="mt-3 font-serif text-lg leading-relaxed" data-testid="question-prompt">
          {plain ? item.question.prompt : <MathText text={item.question.prompt} />}
        </p>
        <button className="mt-1 text-xs text-teal underline" onClick={() => setPlain((p) => !p)}>
          {plain ? "Show formatted maths" : "Show plain text"}
        </button>
      </div>

      {mode !== "checkpoint" && item.attempts.length > 0 && (
        <div className="space-y-3">
          {item.attempts.map((a) => (
            <AttemptBlock key={a.id} attempt={a} onRetried={onChanged} />
          ))}
        </div>
      )}

      {(item.revealedHints.length > 0 || item.revealedSolution || sourcePages) && (
        <div className="space-y-2 rounded-lg border border-sky-ink/20 bg-sky-soft p-3 text-sm" data-testid="help-content">
          {item.revealedHints.map((h) => (
            <p key={h.index}>
              <strong>Hint {h.index + 1}:</strong> <MathText text={h.text} />
            </p>
          ))}
          {item.revealedSolution && (
            <p>
              <strong>Worked solution:</strong> {item.revealedSolution}
            </p>
          )}
          {sourcePages?.map((p) => (
            <details key={p.page} open>
              <summary className="text-xs font-medium">
                {p.label}, PDF page {p.page}
              </summary>
              <pre className="mt-1 whitespace-pre-wrap font-sans text-xs">{p.text}</pre>
            </details>
          ))}
        </div>
      )}

      <div className="space-y-3">
        <label className="block text-sm font-medium" htmlFor={`answer-${item.sessionQuestionId}`}>
          {mode === "repair" ? "Corrected answer" : "Your answer"}
        </label>
        <textarea
          id={`answer-${item.sessionQuestionId}`}
          data-testid="answer-input"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          rows={5}
          maxLength={4000}
          className="w-full rounded-lg border border-line bg-white p-3 text-sm focus:border-teal"
          placeholder="Write your answer in your own words. Plain text is fine (e.g. -ln(0.8))."
        />
        {demoExamples.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted">Offline demo examples (fill the box; not your own work):</span>
            {demoExamples.map((ex) => (
              <button
                key={ex.label}
                type="button"
                className="rounded-md border border-dashed border-amber-ink/40 bg-amber-soft px-2 py-1 text-amber-ink"
                onClick={() => setAnswer(ex.answer)}
                data-testid={`demo-example-${ex.label}`}
              >
                Demo example: {ex.label}
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <fieldset className="flex items-center gap-2">
            <legend className="sr-only">Confidence (optional)</legend>
            <span className="text-xs text-muted">Confidence (optional, does not affect evidence):</span>
            {(["low", "medium", "high"] as const).map((c) => (
              <label key={c} className="flex items-center gap-1 text-xs">
                <input type="radio" name={`conf-${item.sessionQuestionId}`} checked={confidence === c} onChange={() => setConfidence(c)} />
                {c}
              </label>
            ))}
          </fieldset>
          {mode === "checkpoint" && (
            <label className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={declared} onChange={(e) => setDeclared(e.target.checked)} data-testid="declare-assistance" />I
              used outside help (notes, web, AI, another person)
            </label>
          )}
        </div>
        {err && <Notice tone="error">{err}</Notice>}
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => submit(false)} disabled={busy || answer.trim().length === 0} data-testid="submit-answer">
            {busy ? "Saving…" : mode === "repair" ? "Submit correction" : "Submit answer"}
          </Button>
          {mode !== "repair" && (
            <Button variant="secondary" onClick={() => submit(true)} disabled={busy} data-testid="dont-know">
              I don&apos;t know
            </Button>
          )}
        </div>
      </div>

      <div className="border-t border-line pt-3">
        <p className="text-xs text-muted">
          Help{mode === "checkpoint" ? " (marks this skill as supported for the rest of this session)" : ""}:
          {helpUsed && mode === "checkpoint" && <span className="ml-1 font-medium text-amber-ink">help used – this answer will count as supported.</span>}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {nextHint < item.hintCount && (
            <Button variant="ghost" onClick={() => revealHelp("hint", nextHint)} data-testid="reveal-hint">
              {nextHint === 0 ? "Show a hint" : "Show a worked step"}
            </Button>
          )}
          <Button variant="ghost" onClick={() => revealHelp("source")} data-testid="reveal-source">
            Show source pages
          </Button>
          {!item.revealedSolution && (
            <Button variant="ghost" onClick={() => revealHelp("solution")} data-testid="reveal-solution">
              Show worked solution
            </Button>
          )}
        </div>
      </div>
      {latest && mode !== "checkpoint" && latest.status === "assessed" && !latest.feedback && (
        <p className="text-xs text-muted">Feedback for this answer is not released yet.</p>
      )}
    </Card>
  );
}

function AttemptBlock({ attempt, onRetried }: { attempt: Attempt; onRetried: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function retry() {
    setBusy(true);
    try {
      await api(`/api/attempts/${attempt.id}/retry`, { method: "POST", json: {} });
      onRetried();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Retry failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rounded-lg border border-line p-3" data-testid={`attempt-${attempt.phase}`}>
      <p className="text-xs text-muted">
        {attempt.phase === "original" ? "Original answer" : "Correction"} ·{" "}
        {attempt.supportedOnly ? "supported" : "independent conditions"}
        {attempt.declaredAssistance ? " · outside help declared" : ""}
      </p>
      <p className="mt-1 whitespace-pre-wrap text-sm">{attempt.dontKnow ? "I don't know" : attempt.answer}</p>
      {attempt.status === "provider_error" && (
        <div className="mt-2 space-y-2">
          <Notice tone="warn">Assessment failed: {attempt.lastError}. Your answer is saved.</Notice>
          <Button variant="secondary" onClick={retry} disabled={busy}>
            {busy ? "Retrying…" : "Retry assessment"}
          </Button>
          {err && <Notice tone="error">{err}</Notice>}
        </div>
      )}
      {(attempt.status === "assessing" || attempt.status === "pending") && <p className="mt-2 text-xs text-muted">Assessing…</p>}
      {attempt.feedback && <FeedbackBlock feedback={attempt.feedback} />}
    </div>
  );
}

function FeedbackBlock({ feedback }: { feedback: Feedback }) {
  const tone = feedback.outcome === "pass" ? "good" : feedback.outcome === "uncertain" ? "neutral" : "warn";
  return (
    <div className="mt-3 space-y-2" data-testid="feedback">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={tone}>{OUTCOME_TEXT[feedback.outcome]}</Pill>
        <span className="text-xs text-muted">
          judged by {feedback.providerMode === "mock" ? "offline fixture" : feedback.providerMode === "rule" ? "rule" : `live Claude (${feedback.providerModel})`}
        </span>
        {feedback.excluded && <Pill tone="warn">Flagged and excluded</Pill>}
      </div>
      {feedback.validity === "invalid" && (
        <Notice tone="warn">The judgement failed server-side checks ({feedback.problems.join("; ")}). It has no effect on your evidence.</Notice>
      )}
      <ul className="space-y-1 text-sm">
        {feedback.criteria.map((c) => (
          <li key={c.criterionId} className="rounded-md bg-paper p-2">
            <p>
              <strong>{STATUS_TEXT[c.status] ?? c.status}</strong>
              {c.essential ? "" : " (optional)"} – {c.description}
            </p>
            <p className="text-xs text-muted">{c.briefReason}</p>
            {c.answerQuote && <p className="text-xs italic text-muted">From your answer: “{c.answerQuote}”</p>}
          </li>
        ))}
      </ul>
      {feedback.possibleMisconception && (
        <p className="text-sm">
          <strong>Possible misconception:</strong> {feedback.possibleMisconception}
        </p>
      )}
      <details className="text-sm">
        <summary className="text-teal">Reference answer</summary>
        <p className="mt-1 text-muted">{feedback.referenceSummary}</p>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------- results

function ResultsPanel({ sessionId, data, onChanged }: { sessionId: string; data: SessionData; onChanged: (msg?: string) => void }) {
  const results = data.results!;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function release(withholdPending = false) {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/sessions/${sessionId}/feedback`, { method: "POST", json: { withholdPending } });
      onChanged("Feedback released. This is recorded as feedback exposure for these skills.");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not release feedback.");
    } finally {
      setBusy(false);
    }
  }

  async function retry(attemptId: string) {
    setBusy(true);
    try {
      await api(`/api/attempts/${attemptId}/retry`, { method: "POST", json: {} });
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Retry failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4" aria-labelledby="results">
      <h2 id="results" className="font-serif text-xl font-semibold">
        Checkpoint results
      </h2>
      <div className="grid gap-4 md:grid-cols-2">
        {results.skills.map((s) => (
          <Card key={s.skillId}>
            <div data-testid={`result-${s.skillId}`}>
              <p className="text-xs uppercase tracking-wide text-muted">{s.taskType === "calculate" || s.taskType === "apply" ? "Application" : "Explanation"} skill</p>
              <p className="font-medium">{s.objective}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <EvidenceLabel state={s.evidenceState} />
                {s.reassessmentNeeded && <Pill tone="warn">{s.taskType === "calculate" || s.taskType === "apply" ? "Application needs another check" : "Needs another independent check"}</Pill>}
              </div>
              <p className="mt-2 text-sm">
                {!s.answered
                  ? "Not answered in this checkpoint (unassessed)."
                  : s.originalOutcome === null
                    ? "Awaiting assessment."
                    : `This checkpoint: ${OUTCOME_TEXT[s.originalOutcome]}${s.originalIndependent ? " (independent)" : " (supported)"}.`}
              </p>
              <p className="mt-1 text-sm font-medium text-teal-dark" data-testid={`result-due-${s.skillId}`}>
                {s.dueLabel}
              </p>
            </div>
          </Card>
        ))}
      </div>

      {!results.allAssessed && (
        <Card>
          <p className="text-sm">Some answers are still being assessed or the assessment failed.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {results.pendingAttemptIds.map((id, i) => (
              <Button key={id} variant="secondary" onClick={() => retry(id)} disabled={busy}>
                Retry assessment {results.pendingAttemptIds.length > 1 ? i + 1 : ""}
              </Button>
            ))}
            {!results.feedbackReleased && (
              <Button variant="ghost" onClick={() => release(true)} disabled={busy}>
                Continue without feedback for those questions
              </Button>
            )}
          </div>
        </Card>
      )}

      {err && <Notice tone="error">{err}</Notice>}

      {!results.feedbackReleased && results.allAssessed && (
        <Card>
          <p className="text-sm">Your answers are saved and assessed. Criterion-by-criterion feedback is ready.</p>
          <Button className="mt-3" onClick={() => release(false)} disabled={busy} data-testid="release-feedback">
            Show criterion feedback
          </Button>
        </Card>
      )}

      {results.feedbackReleased && isFullItems(data.items) && data.session.status === "ended" && (
        <div className="space-y-3">
          {data.items.map((i) => (
            <Card key={i.sessionQuestionId}>
              <MathText text={i.question.prompt} className="font-serif" />
              {i.attempts.map((a) => (
                <AttemptBlock key={a.id} attempt={a} onRetried={() => onChanged()} />
              ))}
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- learning

function LearnFlow({
  sessionId,
  data,
  onChanged,
  setFlash,
}: {
  sessionId: string;
  data: SessionData;
  onChanged: () => void;
  setFlash: (f: { tone: "good" | "info" | "error" | "warn"; text: string } | null) => void;
}) {
  const [explanation, setExplanation] = useState<{ unitId: string; explanation: string; workedExample: string | null; origin: string } | null>(null);
  const [loadingExp, setLoadingExp] = useState(false);
  const [expErr, setExpErr] = useState<string | null>(null);
  const current = data.current;
  const unitId = current?.unit.id ?? data.units[0]?.unitId;
  const stored = unitId ? data.explanations[unitId] : undefined;
  const shown = explanation?.unitId === unitId ? explanation : stored ? { unitId: unitId!, ...stored, origin: "checked_fixture" } : null;

  async function explain() {
    if (!unitId) return;
    setLoadingExp(true);
    setExpErr(null);
    try {
      const res = await api<{ content: { explanation: string; workedExample: string | null; origin: string } }>(`/api/sessions/${sessionId}/reveal`, {
        method: "POST",
        json: { kind: "explanation", unitId },
      });
      setExplanation({ unitId, ...res.content });
    } catch (e) {
      setExpErr(e instanceof ApiError ? e.message : "Explanation unavailable.");
    } finally {
      setLoadingExp(false);
    }
  }

  async function next() {
    try {
      await api(`/api/sessions/${sessionId}/next`, { method: "POST", json: {} });
      setFlash(null);
      onChanged();
    } catch (e) {
      setFlash({ tone: "error", text: e instanceof ApiError ? e.message : "Could not continue." });
    }
  }

  async function workedExample() {
    if (!current) return;
    await api(`/api/sessions/${sessionId}/reveal`, { method: "POST", json: { kind: "solution", sessionQuestionId: current.sessionQuestionId } }).catch(() => undefined);
    onChanged();
  }

  if (data.session.status === "ended") return null;

  if (data.noQuestionsAvailable) {
    return (
      <Card className="space-y-3">
        <p className="text-sm">No reviewed practice questions are attached to this topic yet. You can still read source-grounded explanations.</p>
        {data.units.map((u) => (
          <p key={u.unitId} className="text-sm">
            <strong>{u.title}:</strong> {u.objective}
          </p>
        ))}
        <Button variant="secondary" onClick={explain} disabled={loadingExp}>
          {loadingExp ? "Preparing explanation…" : "Explain the first objective"}
        </Button>
        {expErr && <Notice tone="warn">{expErr}</Notice>}
        {shown && (
          <div className="rounded-lg bg-paper p-3 text-sm">
            <MathText text={shown.explanation} />
          </div>
        )}
      </Card>
    );
  }

  if (!current) {
    return (
      <Card>
        <p className="text-sm">You have worked through every practice question in this session.</p>
        <p className="mt-1 text-sm text-muted">
          Learning answers count as supported practice. An independent review is scheduled within 24 hours; open the topic to see the dates.
        </p>
        <div className="mt-3 flex gap-2">
          <ButtonLink href={`/topics/${data.topic.id}`}>Back to topic</ButtonLink>
        </div>
      </Card>
    );
  }

  const latest = current.attempts[current.attempts.length - 1];
  const passed = current.attempts.some((a) => a.feedback?.outcome === "pass");

  return (
    <div className="space-y-4">
      <Card>
        <p className="text-xs uppercase tracking-wide text-muted">Step 1 · Objective and explanation</p>
        <h2 className="mt-1 font-serif text-lg font-semibold">{current.unit.title}</h2>
        <p className="text-sm">Objective: {current.unit.objective}</p>
        {!shown ? (
          <Button className="mt-3" variant="secondary" onClick={explain} disabled={loadingExp} data-testid="show-explanation">
            {loadingExp ? "Preparing…" : "Read the explanation and worked example"}
          </Button>
        ) : (
          <div className="mt-3 space-y-3 text-sm" data-testid="explanation">
            <p>
              <MathText text={shown.explanation} />
            </p>
            {shown.workedExample && (
              <div className="rounded-lg bg-paper p-3">
                <p className="text-xs font-semibold uppercase text-muted">Worked example</p>
                <MathText text={shown.workedExample} />
              </div>
            )}
            <p className="text-xs text-muted">{shown.origin === "live_tutor" ? "Generated by the live tutor from approved source pages." : "Checked explanation from the authored content."}</p>
          </div>
        )}
        {expErr && <Notice tone="warn">{expErr}</Notice>}
      </Card>

      <p className="text-xs uppercase tracking-wide text-muted">Step 2 · Practice ({current.ordinal + 1} of {data.progress.total})</p>
      <QuestionCard
        key={current.sessionQuestionId}
        sessionId={sessionId}
        item={current}
        mode="learn"
        demoExamples={data.demoExamples[current.question.id] ?? []}
        onSubmitted={(msg) => {
          setFlash({ tone: "good", text: msg });
          onChanged();
        }}
        onChanged={onChanged}
      />

      {latest?.feedback && !passed && !current.offerAlternatives && (
        <Notice tone="info">Read the criteria above, then try a short correction in the box.</Notice>
      )}
      {latest?.feedback && latest.feedback.outcome !== "pass" && data.provider.mode === "live" && (
        <GapTutor sessionId={sessionId} unitId={current.unit.id} attemptId={latest.id} />
      )}
      {current.offerAlternatives && !passed && (
        <Card>
          <p className="text-sm">Two attempts have not met the criteria yet. That is fine. Choose what helps:</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={workedExample}>
              See a worked example
            </Button>
            <Button variant="secondary" onClick={() => api(`/api/sessions/${sessionId}/end`, { method: "POST", json: { scope: "session" } }).then(onChanged)}>
              Pause here
            </Button>
            <ButtonLink href={`/topics/${data.topic.id}`} variant="secondary">
              Return to topic
            </ButtonLink>
          </div>
        </Card>
      )}
      {(passed || current.offerAlternatives || (latest && latest.feedback?.outcome === "uncertain")) && (
        <Button onClick={next} data-testid="next-question">
          {current.ordinal + 1 < data.progress.total ? "Next practice question" : "Finish practice"}
        </Button>
      )}
    </div>
  );
}

function GapTutor({ sessionId, unitId, attemptId }: { sessionId: string; unitId: string; attemptId: string }) {
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function ask() {
    setBusy(true);
    setErr(null);
    try {
      const res = await api<{ content: { explanation: string } }>(`/api/sessions/${sessionId}/reveal`, {
        method: "POST",
        json: { kind: "explanation", unitId, gapFromAttemptId: attemptId },
      });
      setText(res.content.explanation);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "The tutor is unavailable.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      {!text && (
        <Button variant="secondary" onClick={ask} disabled={busy}>
          {busy ? "Asking the tutor…" : "Ask the live tutor about this gap"}
        </Button>
      )}
      {err && <Notice tone="warn">{err}</Notice>}
      {text && (
        <div className="space-y-1 text-sm">
          <p className="text-xs text-muted">Live tutor, grounded in the approved source pages. It does not grade or change your evidence.</p>
          <p className="whitespace-pre-wrap">
            <MathText text={text} />
          </p>
        </div>
      )}
    </Card>
  );
}
