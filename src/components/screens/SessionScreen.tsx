"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronDown, CircleHelp, LifeBuoy } from "lucide-react";
import type { EvidenceState, TaskType } from "@/lib/domain/types";
import { api, ApiError } from "../api";
import { CriterionFeedback, type FeedbackData } from "../CriterionFeedback";
import { notifyDataChanged } from "../dataEvents";
import { EvidenceLabel } from "../EvidenceLabel";
import { FlagJudgementButton } from "../FlagDialog";
import { AskButton } from "../AskButton";
import { MathText, plainText } from "../MathText";
import type { ProviderInfo } from "../ProviderBadge";
import { useApiResource } from "../useApiResource";
import { ProviderNotice } from "../workspace";
import { ActivityBanner, ActivityCard, isBlocking, type SessionActivity } from "../LearningActivity";
import { Notice, Pill, newSubmissionKey } from "../ui";

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
  feedback: FeedbackData | null;
}

interface Item {
  sessionQuestionId: string;
  ordinal: number;
  repeatedFamily: boolean;
  questionStatus: string;
  question: { id: string; skillId: string; taskType: TaskType; prompt: string };
  skill: { id: string; objective: string };
  unit: { id: string; title: string; objective: string };
  hintCount: number;
  revealedHints: { index: number; text: string }[];
  revealedSolution: string | null;
  attempts: Attempt[];
  answered: boolean;
  offerAlternatives: boolean;
  recentChatHelp: boolean;
}

interface ResultSkill {
  skillId: string;
  sessionQuestionId: string;
  objective: string;
  taskType: TaskType;
  answered: boolean;
  originalOutcome: "pass" | "partial" | "fail" | "uncertain" | null;
  originalIndependent: boolean;
  originalExcluded: boolean;
  repaired: boolean;
  evidenceState: EvidenceState;
  reassessmentNeeded: boolean;
  dueWhen: string | null;
  dueExact: string | null;
}

interface SessionData {
  session: {
    id: string;
    mode: "learn" | "review";
    purpose: "learn" | "practice" | "check" | "review";
    modeLabel: string;
    phase: "checkpoint" | "results" | "repair" | "learning";
    status: "active" | "ended";
    isDemo: boolean;
  };
  topic: { id: string; title: string };
  course: { id: string; title: string; isDemo: boolean };
  provider: ProviderInfo;
  progress: { total: number; answered: number; currentOrdinal: number | null };
  current: Item | null;
  items: Item[] | { ordinal: number; skillObjective: string; answered: boolean; skipped: boolean }[];
  results: null | {
    allAssessed: boolean;
    pendingAttemptIds: string[];
    gradingAttemptIds: string[];
    failedAttemptIds: string[];
    feedbackReleased: boolean;
    skills: ResultSkill[];
    summary: string;
    nextAction: { kind: "practise" | "overview"; label: string; sessionQuestionId: string | null };
  };
  explanations: Record<string, { unitTitle: string; explanation: string; workedExample: string | null }>;
  units: { unitId: string; title: string; objective: string; hasCheckedExplanation: boolean }[];
  noQuestionsAvailable: boolean;
  demoExamples: Record<string, { label: string; answer: string }[]>;
  run: RunInfo | null;
  /** PACER learning activities (learning sessions only). */
  activities: SessionActivity[];
}

interface RunInfo {
  runId: string;
  position: number;
  stepNumber: number;
  totalSteps: number;
  totalMinutes: number;
  current: RunStep;
  steps: RunStep[];
  stepDone: boolean;
  isLast: boolean;
}

interface RunStep {
  position: number;
  kind: string;
  kindLabel: string;
  countsAs: string;
  title: string;
  topicTitle: string;
  state: "done" | "left" | "current" | "upcoming" | "skipped" | "not_reached";
}

const TASK_LABEL: Record<TaskType, string> = {
  explain: "Explanation",
  calculate: "Calculation",
  derive: "Derivation",
  apply: "Application",
};

function isFullItems(items: SessionData["items"]): items is Item[] {
  return items.length === 0 || "sessionQuestionId" in items[0];
}

type Flash = { tone: "good" | "info" | "error" | "warn"; text: string } | null;

const primaryBtn =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-[7px] bg-teal px-4 text-sm font-medium text-white transition-colors hover:bg-teal-dark disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";
const secondaryBtn =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-[7px] border border-line-strong bg-card px-4 text-sm font-medium text-ink transition-colors hover:border-teal hover:text-teal disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";

export function SessionScreen({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const { data, error, reload, setData } = useApiResource<SessionData>(`/api/sessions/${sessionId}`);
  const [flash, setFlash] = useState<Flash>(null);

  // Poll only while an assessment is in flight. Responses never include unreleased judgements.
  const inFlight =
    !!data &&
    ((data.results && !data.results.allAssessed && data.results.pendingAttemptIds.length > 0) ||
      (isFullItems(data.items) && data.items.some((i) => i.attempts.some((a) => a.status === "assessing"))));
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(reload, 2500);
    return () => clearInterval(t);
  }, [inFlight, reload]);

  const run = data?.run ?? null;
  const [advancing, setAdvancing] = useState(false);

  /** Leave this step: the next step's session, or the summary when the run is over. */
  async function nextStep() {
    if (!run) return;
    setAdvancing(true);
    try {
      const res = await api<{ runId: string; sessionId: string | null; done: boolean }>(`/api/runs/${run.runId}/next`, {
        method: "POST",
        json: { fromPosition: run.position },
      });
      notifyDataChanged();
      router.push(res.sessionId && !res.done ? `/sessions/${res.sessionId}` : `/runs/${run.runId}`);
    } catch (err) {
      setFlash({ tone: "error", text: err instanceof ApiError ? err.message : "Could not continue." });
      setAdvancing(false);
    }
  }

  async function stopRun() {
    if (!run) return;
    try {
      await api(`/api/runs/${run.runId}/stop`, { method: "POST", json: {} });
      notifyDataChanged();
      router.push(`/runs/${run.runId}`);
    } catch (err) {
      setFlash({ tone: "error", text: err instanceof ApiError ? err.message : "Could not end the session." });
    }
  }

  async function end(scope: "checkpoint" | "session", thenHome = false) {
    if (run && scope === "session") return stopRun();
    try {
      const view = await api<SessionData>(`/api/sessions/${sessionId}/end`, { method: "POST", json: { scope } });
      notifyDataChanged();
      if (thenHome) return router.push("/");
      setData({ ...view, demoExamples: {} });
      setFlash({
        tone: "info",
        text:
          scope === "checkpoint"
            ? "Check finished early. Saved answers are kept; unanswered questions stay unassessed."
            : "Session ended. Your saved answers are kept.",
      });
    } catch (err) {
      setFlash({ tone: "error", text: err instanceof ApiError ? err.message : "Could not end the session." });
    }
  }

  if (error && !data) {
    return (
      <Notice tone="error" title="We couldn't load this session.">
        {error}{" "}
        <button type="button" className="underline" onClick={reload}>
          Retry
        </button>
      </Notice>
    );
  }
  if (!data) return <div aria-busy="true" className="mx-auto h-[360px] max-w-[760px] rounded-xl border border-line bg-card" />;

  const { session } = data;
  const review = session.mode === "review";

  return (
    <div className="mx-auto max-w-[760px] space-y-6">
      <header className="space-y-3">
        {run ? (
          <RunStepper run={run} />
        ) : (
          <Link href={`/topics/${data.topic.id}`} className="text-sm text-teal hover:underline">
            ← {data.topic.title}
          </Link>
        )}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-[26px] font-semibold leading-tight tracking-tight" data-testid="session-mode">
                {session.modeLabel}
              </h1>
              {session.status === "ended" && <Pill>Ended</Pill>}
              {data.course.isDemo && <Pill tone="warn">Demo</Pill>}
            </div>
            <p className="mt-1 text-sm text-muted">
              {run ? `${run.current.title} · ${data.topic.title}` : data.topic.title} · <span>{countsAsText(session)}</span>
            </p>
            <p className="mt-1 text-sm text-muted" data-testid="progress">
              {review
                ? session.phase === "checkpoint"
                  ? `Question ${Math.min(data.progress.answered + 1, data.progress.total)} of ${data.progress.total} · ${data.progress.answered} answer${data.progress.answered === 1 ? "" : "s"} saved`
                  : `${data.progress.answered} of ${data.progress.total} answers saved`
                : `${data.progress.total} practice question${data.progress.total === 1 ? "" : "s"}`}
            </p>
          </div>
          {session.status === "active" && (
            <div className="flex flex-wrap gap-2">
              {review && session.phase === "checkpoint" && !run && (
                <button type="button" onClick={() => end("checkpoint")} className={secondaryBtn}>
                  Finish check early
                </button>
              )}
              <button type="button" onClick={() => end("session")} className={secondaryBtn} data-testid="end-session">
                End session
              </button>
            </div>
          )}
        </div>
        <ProviderNotice provider={data.provider} />
      </header>

      <div aria-live="polite" role="status">
        {flash && <Notice tone={flash.tone}>{flash.text}</Notice>}
      </div>

      {review && session.phase === "checkpoint" && data.current && (
        <>
          <Notice>
            Answer without hints or notes: that&apos;s what lets this count toward Checked. Help is still there if you need it, but the
            answer will then count as practice. Feedback appears once every answer is saved.
          </Notice>
          <QuestionPanel
            courseId={data.course.id}
            key={data.current.sessionQuestionId}
            sessionId={sessionId}
            item={data.current}
            mode="checkpoint"
            demoExamples={data.demoExamples[data.current.question.id] ?? []}
            onSubmitted={(msg) => {
              setFlash({ tone: "good", text: msg });
              reload();
            }}
            onChanged={reload}
          />
        </>
      )}

      {review && data.results && (
        <ResultsPanel
          sessionId={sessionId}
          data={data}
          onChanged={(msg) => {
            if (msg) setFlash({ tone: "info", text: msg });
            notifyDataChanged();
            reload();
          }}
          onReturnHome={() => end("session", true)}
          run={run}
        />
      )}

      {review && session.phase === "repair" && session.status === "active" && isFullItems(data.items) && repairItems(data).length > 0 && (
        <section className="space-y-4" aria-labelledby="repair-title">
          <h2 id="repair-title" className="text-[17px] font-semibold tracking-tight">
            Fix the gap
          </h2>
          <p className="text-sm text-muted">
            A correction counts as practice. Your first answer and its result stay in your record, and a fresh no-help check is
            scheduled for later.
          </p>
          {repairItems(data).map((i) => {
            const fixed = i.attempts.some((a) => a.phase === "repair" && a.feedback?.outcome === "pass");
            const original = i.attempts.find((a) => a.phase === "original");
            return (
              <QuestionPanel
                courseId={data.course.id}
                key={i.sessionQuestionId}
                sessionId={sessionId}
                item={i}
                mode="repair"
                completed={fixed}
                correctionPrompt={gapPrompt(i.attempts[i.attempts.length - 1]?.feedback ?? original?.feedback ?? null)}
                demoExamples={data.demoExamples[i.question.id] ?? []}
                onSubmitted={() => {
                  notifyDataChanged();
                  reload();
                }}
                onChanged={reload}
              />
            );
          })}
        </section>
      )}

      {!review && <LearnFlow sessionId={sessionId} data={data} onChanged={reload} setFlash={setFlash} onNextStep={run ? nextStep : null} />}

      {run && session.status === "active" && (
        <RunFooter run={run} onNext={nextStep} busy={advancing} />
      )}

      {session.status === "ended" && (
        <div className="flex flex-wrap gap-2">
          <Link href="/" className={primaryBtn}>
            Return to overview
          </Link>
          <Link href={`/topics/${data.topic.id}`} className={secondaryBtn}>
            View topic evidence
          </Link>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- question panel

function QuestionPanel({
  sessionId,
  courseId,
  item,
  mode,
  demoExamples,
  onSubmitted,
  onChanged,
  completed = false,
  correctionPrompt = null,
}: {
  sessionId: string;
  courseId: string;
  item: Item;
  mode: "checkpoint" | "repair" | "learn";
  demoExamples: { label: string; answer: string }[];
  onSubmitted: (message: string) => void;
  onChanged: () => void;
  /** The answer met the criteria: show the record only, no answer form. */
  completed?: boolean;
  /** Shown directly above the answer box when the latest answer missed something. */
  correctionPrompt?: string | null;
}) {
  const [answer, setAnswer] = useState("");
  const [confidence, setConfidence] = useState<"" | "low" | "medium" | "high">("");
  const [declared, setDeclared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [plain, setPlain] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [sourcePages, setSourcePages] = useState<{ label: string; page: number; text: string }[] | null>(null);
  const keyRef = useRef(newSubmissionKey());
  const id = item.sessionQuestionId;

  async function submit(dontKnow = false) {
    if (!dontKnow && answer.trim().length === 0) {
      setErr("Write an answer first, or choose “I don't know”.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await api<{ result: { message: string; assessment: { status: string; message?: string } | null } }>(
        `/api/sessions/${sessionId}/answers`,
        {
          method: "POST",
          json: {
            sessionQuestionId: id,
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
      const failed =
        res.result.assessment?.status === "provider_error"
          ? ` The assessment didn't complete (${res.result.assessment.message}); you can retry it.`
          : "";
      onSubmitted(res.result.message + "." + failed);
    } catch (e) {
      // The same submission key is reused on resend, so a retry can never create a duplicate attempt.
      setErr(e instanceof ApiError ? e.message : "Could not save your answer. Your text is still here; try again.");
    } finally {
      setBusy(false);
    }
  }

  async function revealHelp(kind: "hint" | "source" | "solution", hintIndex?: number) {
    setErr(null);
    try {
      const res = await api<{ content: { pages?: { label: string; page: number; text: string }[] } }>(`/api/sessions/${sessionId}/reveal`, {
        method: "POST",
        json: { kind, sessionQuestionId: id, hintIndex },
      });
      if (kind === "source") setSourcePages(res.content.pages ?? []);
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Help is unavailable right now.");
    }
  }

  const nextHint = item.revealedHints.length;
  const helpUsed = item.revealedHints.length > 0 || item.revealedSolution !== null || sourcePages !== null;

  return (
    <section aria-labelledby={`prompt-${id}`} id={`question-${id}`} tabIndex={-1} className="space-y-4 rounded-xl border border-line bg-card p-5 sm:p-6">
      <div data-testid="question-card" data-question-id={item.question.id}>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <Pill tone="teal">{TASK_LABEL[item.question.taskType]} question</Pill>
          <span>{item.skill.objective}</span>
          {item.repeatedFamily && mode === "checkpoint" && <Pill tone="warn">Repeated question family</Pill>}
          {item.questionStatus === "authored_fixture" && <Pill>Authored fixture</Pill>}
        </div>
        <p id={`prompt-${id}`} className="mt-3 text-[17px] leading-relaxed" data-testid="question-prompt">
          {plain ? plainText(item.question.prompt) : <MathText text={item.question.prompt} />}
        </p>
        <button type="button" className="mt-1 min-h-8 text-xs text-teal underline" onClick={() => setPlain((p) => !p)}>
          {plain ? "Show formatted maths" : "Show plain text"}
        </button>
      </div>

      {mode === "checkpoint" && item.recentChatHelp && (
        <p className="rounded-lg bg-amber-soft px-3 py-2 text-sm text-amber-ink" data-testid="recent-chat-notice">
          You asked the lecture chat about this in the last few hours, so this answer will count as practice rather than toward
          Checked.
        </p>
      )}

      {mode !== "checkpoint" && item.attempts.length > 0 && (
        <div className="space-y-3">
          {item.attempts.map((a) => (
            <AttemptBlock key={a.id} attempt={a} onChanged={onChanged} />
          ))}
        </div>
      )}

      {(item.revealedHints.length > 0 || item.revealedSolution || sourcePages) && (
        <div className="space-y-2 rounded-lg border border-amber-ink/20 bg-amber-soft p-3 text-sm" data-testid="help-content">
          <p className="text-xs font-medium text-amber-ink">Help recorded for this skill in this session</p>
          {item.revealedHints.map((h) => (
            <p key={h.index}>
              <strong className="font-medium">{h.index === 0 ? "Cue" : "Worked step"}:</strong> <MathText text={h.text} />
            </p>
          ))}
          {item.revealedSolution && (
            <p>
              <strong className="font-medium">Worked solution:</strong> {item.revealedSolution}
            </p>
          )}
          {sourcePages?.length === 0 && <p className="text-xs">No source pages are available for this question.</p>}
          {sourcePages?.map((p) => (
            <details key={p.page} open>
              <summary className="min-h-8 text-xs font-medium">
                {p.label}, PDF page {p.page}
              </summary>
              <pre className="mt-1 whitespace-pre-wrap font-sans text-xs">{p.text}</pre>
            </details>
          ))}
        </div>
      )}

      {!completed && (
      <>
      {correctionPrompt && (
        <div className="rounded-lg bg-sky-soft px-4 py-3 text-sm text-sky-ink" data-testid="correction-prompt">
          <p className="font-medium">Fix the gap</p>
          <p className="mt-0.5">{correctionPrompt}</p>
        </div>
      )}
      <div className="space-y-3">
        <label className="block text-sm font-medium" htmlFor={`answer-${id}`}>
          {mode === "repair" || correctionPrompt ? "Your correction" : "Your answer"}
        </label>
        <textarea
          id={`answer-${id}`}
          data-testid="answer-input"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          rows={5}
          maxLength={4000}
          aria-describedby={err ? `err-${id}` : undefined}
          className="w-full rounded-lg border border-line-strong bg-white p-3 text-[15px] focus:border-teal"
          placeholder="Write your answer in your own words. Plain text is fine, e.g. -ln(0.8)."
        />
        {demoExamples.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted">Offline demo examples (fill the box; not your own work):</span>
            {demoExamples.map((ex) => (
              <button
                key={ex.label}
                type="button"
                className="min-h-9 rounded-md border border-dashed border-amber-ink/40 bg-amber-soft px-2 text-amber-ink"
                onClick={() => setAnswer(ex.answer)}
                data-testid={`demo-example-${ex.label}`}
              >
                Demo example: {ex.label}
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <fieldset className="flex flex-wrap items-center gap-2">
            <legend className="sr-only">Confidence (optional)</legend>
            <span className="text-xs text-muted">Confidence (optional, never affects evidence):</span>
            {(["low", "medium", "high"] as const).map((c) => (
              <label key={c} className="flex min-h-8 items-center gap-1 text-xs">
                <input type="radio" name={`conf-${id}`} checked={confidence === c} onChange={() => setConfidence(c)} />
                {c}
              </label>
            ))}
          </fieldset>
          {mode === "checkpoint" && (
            <label className="flex min-h-8 items-center gap-1.5 text-xs">
              <input type="checkbox" checked={declared} onChange={(e) => setDeclared(e.target.checked)} data-testid="declare-assistance" />I used
              notes or outside help
            </label>
          )}
        </div>
        {err && (
          <p id={`err-${id}`} role="alert" className="rounded-lg bg-red-soft px-3 py-2 text-sm text-red-ink">
            {err}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => submit(false)} disabled={busy} className={primaryBtn} data-testid="submit-answer">
            {busy ? "Saving answer…" : mode === "repair" || correctionPrompt ? "Submit correction" : "Submit answer"}
          </button>
          {mode !== "repair" && !correctionPrompt && (
            <button type="button" onClick={() => submit(true)} disabled={busy} className={secondaryBtn} data-testid="dont-know">
              I don&apos;t know
            </button>
          )}
          <button
            type="button"
            onClick={() => setHelpOpen((o) => !o)}
            aria-expanded={helpOpen}
            aria-controls={`help-${id}`}
            className={secondaryBtn}
            data-testid="get-help"
          >
            <LifeBuoy size={16} aria-hidden="true" />
            Get help
            <ChevronDown size={14} aria-hidden="true" className={helpOpen ? "rotate-180" : ""} />
          </button>
        </div>
      </div>

      <div id={`help-${id}`} hidden={!helpOpen} className="rounded-lg border border-line bg-paper p-4">
        <p className="flex items-start gap-2 text-sm">
          <CircleHelp size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-amber-ink" />
          <span>
            {mode === "checkpoint"
              ? "Using help is fine, but it is recorded: your answer to this question will then count as practice, not toward Checked."
              : "Help is part of practice. It is recorded, and answers here always count as practice."}
            {helpUsed && mode === "checkpoint" && <strong className="ml-1 font-medium text-amber-ink">Help is now recorded for this skill.</strong>}
          </span>
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {nextHint < item.hintCount && (
            <button type="button" className={secondaryBtn} onClick={() => revealHelp("hint", nextHint)} data-testid="reveal-hint">
              {nextHint === 0 ? "Show a general cue" : "Show a worked step"}
            </button>
          )}
          <button type="button" className={secondaryBtn} onClick={() => revealHelp("source")} data-testid="reveal-source">
            Show source pages
          </button>
          {!item.revealedSolution && (
            <button type="button" className={secondaryBtn} onClick={() => revealHelp("solution")} data-testid="reveal-solution">
              Show worked solution
            </button>
          )}
          <AskButton courseId={courseId} variant="help" />
        </div>
      </div>
      </>
      )}
    </section>
  );
}

function AttemptBlock({ attempt, onChanged }: { attempt: Attempt; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function retry() {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/attempts/${attempt.id}/retry`, { method: "POST", json: {} });
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Retry failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rounded-lg border border-line p-3" data-testid={`attempt-${attempt.phase}`}>
      <p className="text-xs text-muted">
        {attempt.phase === "original" ? "Your answer" : "Your correction"} · {attempt.supportedOnly ? "counts as practice" : "no help used"}
        {attempt.declaredAssistance ? " · outside help declared" : ""}
      </p>
      <p className="mt-1 whitespace-pre-wrap text-sm">{attempt.dontKnow ? "I don't know" : attempt.answer}</p>
      {attempt.status === "provider_error" && (
        <div className="mt-2 space-y-2">
          <Notice tone="warn">Your answer is saved, but the assessment didn&apos;t complete: {attempt.lastError}</Notice>
          <button type="button" onClick={retry} disabled={busy} className={secondaryBtn}>
            {busy ? "Retrying…" : "Retry assessment"}
          </button>
          {err && <p className="text-sm text-red-ink">{err}</p>}
        </div>
      )}
      {(attempt.status === "assessing" || attempt.status === "pending") && <p className="mt-2 text-xs text-muted">Answer saved · assessing…</p>}
      {attempt.feedback && (
        <div className="mt-3 space-y-2">
          <CriterionFeedback feedback={attempt.feedback} />
          {!attempt.feedback.excluded && <FlagJudgementButton assessmentId={attempt.feedback.assessmentId} onFlagged={onChanged} />}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- results

function ResultsPanel({
  sessionId,
  data,
  onChanged,
  onReturnHome,
  run,
}: {
  sessionId: string;
  data: SessionData;
  onChanged: (msg?: string) => void;
  onReturnHome: () => void;
  run: RunInfo | null;
}) {
  const router = useRouter();
  const results = data.results!;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const items = isFullItems(data.items) ? data.items : [];

  async function release(withholdPending = false) {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/sessions/${sessionId}/feedback`, { method: "POST", json: { withholdPending } });
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not release feedback.");
    } finally {
      setBusy(false);
    }
  }

  async function retry(attemptId: string) {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/attempts/${attemptId}/retry`, { method: "POST", json: {} });
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Retry failed.");
    } finally {
      setBusy(false);
    }
  }

  async function freshQuestion(skillId: string) {
    setBusy(true);
    try {
      const res = await api<{ sessionId: string }>("/api/sessions", {
        method: "POST",
        json: { topicId: data.topic.id, purpose: "check", skillIds: [skillId] },
      });
      router.push(`/sessions/${res.sessionId}`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not start a fresh question.");
      setBusy(false);
    }
  }

  function goPractise(sqId: string) {
    const el = document.getElementById(`question-${sqId}`);
    el?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    el?.focus({ preventScroll: true });
  }

  // Feedback is released as soon as every answer is assessed; the learner shouldn't have to ask for it.
  const autoReleased = useRef(false);
  useEffect(() => {
    if (results.allAssessed && !results.feedbackReleased && !autoReleased.current) {
      autoReleased.current = true;
      void release(false);
    }
  });

  const active = data.session.status === "active";
  return (
    <section className="space-y-4" aria-labelledby="results-title">
      <div className="rounded-xl border border-line bg-card p-5 sm:p-6">
        <h2 id="results-title" className="text-[13px] font-medium uppercase tracking-[0.08em] text-muted">
          Results
        </h2>
        <p className="mt-2 text-[19px] font-semibold leading-snug" data-testid="results-summary">
          {results.summary || "No answers were saved in this check."}
        </p>
        {results.feedbackReleased && active && !(run && results.nextAction.kind === "overview") && (
          <div className="mt-4 flex flex-wrap gap-2">
            {results.nextAction.kind === "practise" ? (
              <button
                type="button"
                className={primaryBtn}
                onClick={() => goPractise(results.nextAction.sessionQuestionId!)}
                data-testid="next-action"
              >
                {results.nextAction.label}
                <ArrowRight size={16} aria-hidden="true" />
              </button>
            ) : run ? null : (
              <button type="button" className={primaryBtn} onClick={onReturnHome} data-testid="next-action">
                Return to overview
                <ArrowRight size={16} aria-hidden="true" />
              </button>
            )}
            {!run && (
              <Link href={`/topics/${data.topic.id}`} className={secondaryBtn}>
                View topic
              </Link>
            )}
          </div>
        )}
      </div>

      <ul className="space-y-3">
        {results.skills.map((s) => {
          const item = items.find((i) => i.sessionQuestionId === s.sessionQuestionId);
          const original = item?.attempts.find((a) => a.phase === "original");
          return (
            <li key={s.skillId} className="rounded-xl border border-line bg-card p-4 sm:p-5" data-testid={`result-${s.skillId}`}>
              <p className="text-xs font-medium uppercase tracking-[0.06em] text-muted">{TASK_LABEL[s.taskType]}</p>
              <p className="mt-0.5 text-[15px] font-medium">{s.objective}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <EvidenceLabel state={s.evidenceState} />
                {s.reassessmentNeeded && (
                  <Pill tone="warn">
                    {s.taskType === "calculate" || s.taskType === "apply" ? "Application needs another check" : "Needs another check"}
                  </Pill>
                )}
              </div>
              <p className="mt-2 text-sm">
                {!s.answered
                  ? "Not answered in this check, so it stays unassessed."
                  : s.originalOutcome === null
                    ? results.gradingAttemptIds.includes(original?.id ?? "")
                      ? "Answer saved · grading…"
                      : "Answer saved · assessment pending."
                    : s.originalExcluded
                      ? "This judgement is excluded from your learning record."
                      : s.originalOutcome === "uncertain"
                        ? "Not enough evidence to judge this answer. Nothing was recorded from it."
                        : s.originalOutcome === "pass"
                          ? s.originalIndependent
                            ? "Your answer met every essential criterion with no help."
                            : "Your answer met the criteria with help."
                          : s.repaired
                            ? "Your first answer missed a step; your correction fixed it with help."
                            : "Your answer missed an essential step."}
              </p>
              {s.dueWhen && (
                <p className="mt-1 text-sm font-medium text-teal-dark" data-testid={`result-due-${s.skillId}`}>
                  Next no-help check {s.dueWhen} <span className="text-xs font-normal text-muted">({s.dueExact})</span>
                </p>
              )}
              {original?.feedback && (
                <details className="mt-3">
                  <summary className="inline-flex min-h-9 cursor-pointer items-center text-sm text-teal underline underline-offset-2">
                    Feedback on your answer
                  </summary>
                  <div className="mt-2 space-y-2">
                    <p className="whitespace-pre-wrap rounded-md bg-paper p-2 text-sm">{original.dontKnow ? "I don't know" : original.answer}</p>
                    <CriterionFeedback feedback={original.feedback} />
                    {!original.feedback.excluded && (
                      <FlagJudgementButton assessmentId={original.feedback.assessmentId} onFlagged={() => onChanged()} />
                    )}
                  </div>
                </details>
              )}
              {s.originalOutcome === "uncertain" && !s.originalExcluded && active && (
                <button type="button" className={`${secondaryBtn} mt-3`} onClick={() => freshQuestion(s.skillId)} disabled={busy}>
                  Try a fresh question
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {!results.allAssessed && (
        <div className="rounded-xl border border-line bg-card p-4">
          <p className="text-sm" data-testid="results-grading">
            {results.failedAttemptIds.length === 0
              ? "Your answers are saved and being graded. This page updates by itself."
              : results.gradingAttemptIds.length > 0
                ? "Your answers are saved. Some are still being graded and some assessments didn't complete."
                : "Your answers are saved. Some assessments didn't complete."}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {results.failedAttemptIds.map((id, i) => (
              <button key={id} type="button" className={secondaryBtn} onClick={() => retry(id)} disabled={busy} data-testid="retry-assessment">
                Retry assessment{results.failedAttemptIds.length > 1 ? ` ${i + 1}` : ""}
              </button>
            ))}
            {!results.feedbackReleased && (
              <button type="button" className={secondaryBtn} onClick={() => release(true)} disabled={busy}>
                Continue without feedback for those
              </button>
            )}
          </div>
        </div>
      )}

      {err && <Notice tone="error">{err}</Notice>}

      {!results.feedbackReleased && results.allAssessed && (
        <div className="rounded-xl border border-line bg-card p-4">
          <p className="text-sm">{busy ? "Preparing your feedback…" : "All answers are assessed. Your feedback is ready."}</p>
          <button type="button" className={`${primaryBtn} mt-3`} onClick={() => release(false)} disabled={busy} data-testid="release-feedback">
            Show feedback
          </button>
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
  onNextStep,
}: {
  sessionId: string;
  data: SessionData;
  onChanged: () => void;
  setFlash: (f: Flash) => void;
  /** Inside a study run, finishing moves to the next step instead of the overview. */
  onNextStep: (() => void) | null;
}) {
  const router = useRouter();
  const [explanation, setExplanation] = useState<{ unitId: string; explanation: string; workedExample: string | null; origin: string } | null>(null);
  const [loadingExp, setLoadingExp] = useState(false);
  const [expErr, setExpErr] = useState<string | null>(null);
  const current = data.current;
  const unitId = current?.unit.id ?? data.units[0]?.unitId;
  const stored = unitId ? data.explanations[unitId] : undefined;
  const shown = explanation?.unitId === unitId ? explanation : stored ? { unitId: unitId!, ...stored, origin: "checked_fixture" } : null;
  const practice = data.session.purpose === "practice";
  const checkedExplanation = data.units.find((u) => u.unitId === unitId)?.hasCheckedExplanation ?? false;
  const activities = current ? data.activities.filter((a) => a.skillId === current.skill.id) : [];
  // Connect comes before teaching: a pending primary activity holds the explanation and the question back.
  const blocking = activities.find(isBlocking) ?? null;

  // Learning explains first: a checked explanation opens on its own (live tutor explanations stay on request).
  const autoExplained = useRef<string | null>(null);
  useEffect(() => {
    if (practice || blocking || shown || !unitId || !checkedExplanation || data.session.status !== "active") return;
    if (autoExplained.current === unitId) return;
    autoExplained.current = unitId;
    void explain();
  });

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
      notifyDataChanged();
      onChanged();
    } catch (e) {
      setFlash({ tone: "error", text: e instanceof ApiError ? e.message : "Could not continue." });
    }
  }

  async function workedExample() {
    if (!current) return;
    await api(`/api/sessions/${sessionId}/reveal`, { method: "POST", json: { kind: "solution", sessionQuestionId: current.sessionQuestionId } }).catch(
      () => undefined,
    );
    onChanged();
  }

  async function finish() {
    if (onNextStep) return onNextStep();
    await api(`/api/sessions/${sessionId}/end`, { method: "POST", json: { scope: "session" } }).catch(() => undefined);
    notifyDataChanged();
    router.push("/");
  }

  if (data.session.status === "ended") return null;

  if (data.noQuestionsAvailable) {
    return (
      <div className="space-y-3 rounded-xl border border-line bg-card p-5">
        <p className="text-sm">No reviewed practice questions are attached to this topic yet. You can still read source-grounded explanations.</p>
        {data.units.map((u) => (
          <p key={u.unitId} className="text-sm">
            <strong className="font-medium">{u.title}:</strong> {u.objective}
          </p>
        ))}
        <button type="button" className={secondaryBtn} onClick={explain} disabled={loadingExp}>
          {loadingExp ? "Preparing explanation…" : "Explain the first objective"}
        </button>
        {expErr && <Notice tone="warn">{expErr}</Notice>}
        {shown && (
          <div className="rounded-lg bg-paper p-3 text-sm">
            <MathText text={shown.explanation} />
          </div>
        )}
      </div>
    );
  }

  if (!current) {
    return (
      <div className="rounded-xl border border-line bg-teal-soft p-5" data-testid="step-outcome">
        <p className="text-[17px] font-semibold">Practice done</p>
        <p className="mt-1 text-sm">
          Answers with help available count as practice. A fresh no-help check is scheduled for later; that&apos;s what moves a subtopic
          to Checked.
        </p>
        {!onNextStep && (
          <button type="button" className={`${primaryBtn} mt-3`} onClick={finish}>
            Return to overview
          </button>
        )}
      </div>
    );
  }

  const latest = current.attempts[current.attempts.length - 1];
  const passed = current.attempts.some((a) => a.feedback?.outcome === "pass");

  if (blocking) {
    return (
      <div className="space-y-4">
        <p className="text-xs font-medium uppercase tracking-[0.06em] text-muted">
          {current.unit.title} · before practice question {current.ordinal + 1} of {data.progress.total}
        </p>
        <ActivityCard key={blocking.id} sessionId={sessionId} activity={blocking} onChanged={onChanged} />
      </div>
    );
  }

  const banners = activities.filter((a) => a.status === "unavailable" || (a.steps.length === 0 && a.status === "open"));
  const finishedPrimary = activities.filter((a) => a.role === "primary" && a.steps.length > 0 && a.status === "completed");
  const optional = activities.filter((a) => a.role === "secondary" && a.steps.length > 0);

  return (
    <div className="space-y-4">
      {finishedPrimary.map((a) => (
        <ActivityCard key={a.id} sessionId={sessionId} activity={a} onChanged={onChanged} />
      ))}
      {optional.map((a) => (
        <ActivityCard key={a.id} sessionId={sessionId} activity={a} onChanged={onChanged} collapsible />
      ))}
      {!practice && (
        <div className="rounded-xl border border-line bg-card p-5">
          <p className="text-xs font-medium uppercase tracking-[0.06em] text-muted">Read first</p>
          <h2 className="mt-1 text-[19px] font-semibold">{current.unit.title}</h2>
          <p className="text-sm">Objective: {current.unit.objective}</p>
          {!shown ? (
            <button type="button" className={`${secondaryBtn} mt-3`} onClick={explain} disabled={loadingExp} data-testid="show-explanation">
              {loadingExp ? "Preparing…" : "Read the explanation and worked example"}
            </button>
          ) : (
            <div className="mt-3 space-y-3 text-[15px]" data-testid="explanation">
              <p>
                <MathText text={shown.explanation} />
              </p>
              {shown.workedExample && (
                <div className="rounded-lg bg-paper p-3">
                  <p className="text-xs font-medium uppercase text-muted">Worked example</p>
                  <MathText text={shown.workedExample} />
                </div>
              )}
              <p className="text-xs text-muted">
                {shown.origin === "live_tutor" ? "Generated by the live tutor from approved source pages." : "Checked explanation from the authored content."}
              </p>
            </div>
          )}
          {expErr && <Notice tone="warn">{expErr}</Notice>}
        </div>
      )}

      {banners.map((a) => (
        <ActivityBanner key={a.id} activity={a} />
      ))}
      <p className="text-xs font-medium uppercase tracking-[0.06em] text-muted">
        Practice question {current.ordinal + 1} of {data.progress.total} · help available, counts as practice
      </p>
      <QuestionPanel
        courseId={data.course.id}
        key={current.sessionQuestionId}
        sessionId={sessionId}
        item={current}
        mode="learn"
        completed={passed}
        correctionPrompt={
          latest?.feedback && !passed && !current.offerAlternatives && latest.feedback.outcome !== "uncertain" ? gapPrompt(latest.feedback) : null
        }
        demoExamples={data.demoExamples[current.question.id] ?? []}
        onSubmitted={() => {
          setFlash(null);
          notifyDataChanged();
          onChanged();
        }}
        onChanged={onChanged}
      />

      {passed && (
        <div className="rounded-xl bg-teal-soft px-5 py-4 text-sm" data-testid="step-outcome">
          <p className="font-semibold">All essential criteria met.</p>
          <p className="mt-0.5">
            This counts as practice for {current.unit.title}. A no-help check comes later; that&apos;s what moves it to Checked.
          </p>
        </div>
      )}
      {latest?.feedback && latest.feedback.outcome !== "pass" && data.provider.mode === "live" && (
        <GapTutor sessionId={sessionId} unitId={current.unit.id} attemptId={latest.id} />
      )}
      {current.offerAlternatives && !passed && (
        <div className="rounded-xl border border-line bg-card p-4">
          <p className="text-sm">Two attempts haven&apos;t met the criteria yet. That&apos;s fine. Choose what helps:</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={secondaryBtn} onClick={workedExample}>
              See a worked example
            </button>
            <button type="button" className={secondaryBtn} onClick={finish}>
              Pause here
            </button>
            <Link href={`/topics/${data.topic.id}`} className={secondaryBtn}>
              Return to topic
            </Link>
          </div>
        </div>
      )}
      {(passed || current.offerAlternatives || latest?.feedback?.outcome === "uncertain") && (
        <button type="button" className={primaryBtn} onClick={next} data-testid="next-question">
          {current.ordinal + 1 < data.progress.total ? "Next question" : "Finish practice"}
        </button>
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
    <div className="rounded-xl border border-line bg-card p-4">
      {!text && (
        <button type="button" className={secondaryBtn} onClick={ask} disabled={busy}>
          {busy ? "Asking the tutor…" : "Ask the tutor about this gap"}
        </button>
      )}
      {err && <Notice tone="warn">{err}</Notice>}
      {text && (
        <div className="space-y-1 text-sm">
          <p className="text-xs text-muted">Tutor explanation grounded in the approved source pages. It does not grade or change your evidence.</p>
          <p className="whitespace-pre-wrap">
            <MathText text={text} />
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- study run

/** What this session's answers count toward, in plain words. */
function countsAsText(session: SessionData["session"]): string {
  if (session.mode === "review" && session.phase === "checkpoint") return "no help, counts toward Checked";
  return "help available, counts as practice";
}

/** Checkpoint questions whose first answer missed a step: the only ones offered for correction. */
function repairItems(data: SessionData): Item[] {
  if (!isFullItems(data.items) || !data.results) return [];
  const missed = new Set(
    data.results.skills.filter((s) => !s.originalExcluded && (s.originalOutcome === "partial" || s.originalOutcome === "fail")).map((s) => s.sessionQuestionId),
  );
  return data.items.filter((i) => i.answered && missed.has(i.sessionQuestionId));
}

/** One plain sentence naming what the latest answer still needs. */
function gapPrompt(feedback: FeedbackData | null): string | null {
  if (!feedback) return null;
  const missing = feedback.criteria.filter((c) => c.status !== "met" && c.essential).map((c) => c.description.replace(/\.$/, ""));
  const list = missing.length ? `Still needed: ${missing.join("; ")}.` : "Look at the criteria above.";
  return `${list} Write a short correction below. Help is available, and this counts as practice.`;
}

function RunStepper({ run }: { run: RunInfo }) {
  const visible = run.steps.filter((s) => s.state !== "skipped");
  return (
    <nav aria-label="Session progress" data-testid="run-stepper">
      <p className="mb-2 text-xs text-muted">
        Study session · step {run.stepNumber} of {run.totalSteps} · about {run.totalMinutes} minutes
      </p>
      <ol className="flex gap-1.5">
        {visible.map((s) => (
          <li key={s.position} className="min-w-0 flex-1" aria-current={s.state === "current" ? "step" : undefined}>
            <span
              className={`block h-1 rounded-full ${
                s.state === "done" ? "bg-teal" : s.state === "current" ? "bg-teal/45" : s.state === "left" ? "bg-line-strong" : "bg-line"
              }`}
              aria-hidden="true"
            />
            <span className={`mt-1.5 block truncate text-[11px] ${s.state === "current" ? "font-medium text-ink" : "text-muted"}`}>
              {s.kindLabel}: {s.title}
              <span className="sr-only">{s.state === "done" ? " (done)" : s.state === "current" ? " (current)" : s.state === "left" ? " (not finished)" : ""}</span>
            </span>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** Way out of the current step: a sticky primary action once the step is done, otherwise a quiet skip at the end. */
function RunFooter({ run, onNext, busy }: { run: RunInfo; onNext: () => void; busy: boolean }) {
  const label = run.isLast ? "Finish session" : "Next step";
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 ${
        run.stepDone ? "sticky bottom-4 z-10 border-teal/30 bg-card shadow-lg" : "border-line bg-card"
      }`}
      data-testid="run-footer"
    >
      <p className="text-sm text-muted">
        {run.stepDone
          ? run.isLast
            ? "That was the last step."
            : `Up next: ${run.steps.find((s) => s.position > run.position && s.state !== "skipped")?.kindLabel ?? ""} · ${
                run.steps.find((s) => s.position > run.position && s.state !== "skipped")?.title ?? ""
              }`
          : "Answers you've saved are kept if you move on."}
      </p>
      <button type="button" onClick={onNext} disabled={busy} className={run.stepDone ? primaryBtn : secondaryBtn} data-testid="next-step">
        {busy ? "Opening…" : run.stepDone ? label : run.isLast ? "Skip and finish" : "Skip this step"}
        <ArrowRight size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

