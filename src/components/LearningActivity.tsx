"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { MathText } from "./MathText";
import { notifyDataChanged } from "./dataEvents";
import { Notice, Pill, newSubmissionKey } from "./ui";

export interface ActivityStep {
  key: "connect" | "reconstruct" | "respond" | "recall";
  title: string;
  prompt: string;
  hints: string[];
  expected: string;
}

export interface SessionActivity {
  id: string;
  skillId: string;
  role: "primary" | "secondary";
  templateId: string;
  label: string;
  pacerType: string;
  typeLabel: string;
  optional: boolean;
  status: "open" | "teach" | "completed" | "skipped" | "unavailable";
  stepIndex: number;
  steps: ActivityStep[];
  teachAfterStep: number | null;
  teachUnitId: string | null;
  excerpts: { chunkId: string; label: string; page: number | null; text: string; origin: string }[];
  note: string;
  responses: { stepIndex: number; text: string; submittedAt: number }[];
}

const primaryBtn =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-[7px] bg-teal px-4 text-sm font-medium text-white transition-colors hover:bg-teal-dark disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";
const secondaryBtn =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-[7px] border border-line-strong bg-card px-4 text-sm font-medium text-ink transition-colors hover:border-teal hover:text-teal disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";

/** Does this activity have to be done (or skipped) before the skill's practice question? */
export function isBlocking(a: SessionActivity): boolean {
  return a.role === "primary" && a.steps.length > 0 && (a.status === "open" || a.status === "teach");
}

/** Banner for activities that wrap the existing practice question, and honest "no template" notices. */
export function ActivityBanner({ activity: a }: { activity: SessionActivity }) {
  if (a.status === "unavailable") {
    return (
      <Notice tone="info" title="No prepared activity for this approach">
        The ordinary learning flow continues. You can choose another approach on the topic page.
      </Notice>
    );
  }
  return (
    <div className="rounded-[10px] border border-line bg-paper px-4 py-3 text-sm" data-testid="pacer-practice-banner">
      <p className="font-medium">
        {a.typeLabel} · {a.label}
      </p>
      <p className="mt-0.5 text-muted">{a.note}</p>
    </div>
  );
}

/** One authored learning activity: prompt, response, teaching between Connect and Reconstruct. */
export function ActivityCard({
  sessionId,
  activity: a,
  onChanged,
  collapsible = false,
}: {
  sessionId: string;
  activity: SessionActivity;
  onChanged: () => void;
  /** Optional activities start collapsed behind Start / Skip. */
  collapsible?: boolean;
}) {
  const [open, setOpen] = useState(!collapsible);
  const [text, setText] = useState("");
  const [hints, setHints] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [teaching, setTeaching] = useState<{ explanation: string; workedExample: string | null } | null>(null);
  const keyRef = useRef(newSubmissionKey());
  const step = a.status === "open" ? a.steps[a.stepIndex] : undefined;
  const done = a.status === "completed" || a.status === "skipped";

  // Teaching is fetched through the reveal flow, which commits the explanation exposure before returning it.
  const teachRequested = useRef(false);
  useEffect(() => {
    if (a.status !== "teach" || !a.teachUnitId || teachRequested.current) return;
    teachRequested.current = true;
    api<{ content: { explanation: string; workedExample: string | null } }>(`/api/sessions/${sessionId}/reveal`, {
      method: "POST",
      json: { kind: "explanation", unitId: a.teachUnitId },
    })
      .then((res) => setTeaching(res.content))
      .catch((e) => setErr(e instanceof ApiError ? e.message : "The explanation is unavailable."));
  }, [a.status, a.teachUnitId, sessionId]);

  async function submit() {
    if (!step) return;
    if (!text.trim()) {
      setErr("Write a response first, or skip this activity.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/sessions/${sessionId}/activities/${a.id}/responses`, {
        method: "POST",
        json: { submissionKey: keyRef.current, stepIndex: a.stepIndex, text },
      });
      keyRef.current = newSubmissionKey();
      setText("");
      setHints(0);
      notifyDataChanged();
      onChanged();
    } catch (e) {
      // The same key is reused on resend, so a retry never saves the response twice.
      setErr(e instanceof ApiError ? e.message : "Could not save your response. Your text is still here; try again.");
    } finally {
      setBusy(false);
    }
  }

  async function advance(action: "continue" | "skip") {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/sessions/${sessionId}/activities/${a.id}/advance`, { method: "POST", json: { action } });
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not continue.");
    } finally {
      setBusy(false);
    }
  }

  const titleId = `activity-${a.id}`;
  const stepNumber = Math.min(a.stepIndex + 1, a.steps.length);

  if (collapsible && !open && !done) {
    return (
      <section aria-labelledby={titleId} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-card px-5 py-4" data-testid="pacer-optional">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.06em] text-muted">Optional learning activity · {a.typeLabel}</p>
          <h3 id={titleId} className="mt-0.5 font-semibold">
            {a.label}
          </h3>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={secondaryBtn} onClick={() => setOpen(true)}>
            Start
          </button>
          <button type="button" className={secondaryBtn} onClick={() => advance("skip")} disabled={busy}>
            Skip
          </button>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby={titleId} className="space-y-4 rounded-xl border border-line bg-card p-5 sm:p-6" data-testid="pacer-activity" data-template={a.templateId}>
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.06em] text-muted">
          Learning activity · {a.typeLabel}
          {a.optional ? " · optional" : ""}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h2 id={titleId} className="text-[19px] font-semibold">
            {a.label}
          </h2>
          {a.status === "completed" && <Pill tone="teal">Response saved</Pill>}
          {a.status === "skipped" && <Pill>Skipped</Pill>}
        </div>
        {!done && a.steps.length > 1 && (
          <p className="mt-1 text-sm text-muted" data-testid="activity-progress">
            Step {a.status === "teach" ? `${a.stepIndex} of ${a.steps.length} done · read the explanation` : `${stepNumber} of ${a.steps.length} · ${step?.title ?? ""}`}
          </p>
        )}
      </div>

      {a.excerpts.length > 0 && !done && (
        <div className="space-y-2">
          {a.excerpts.map((x) => (
            <figure key={x.chunkId} className="rounded-lg border-l-4 border-teal bg-paper px-4 py-3 text-sm">
              <blockquote className="whitespace-pre-wrap">
                <MathText text={x.text} />
              </blockquote>
              <figcaption className="mt-1 text-xs text-muted">
                {x.label}
                {x.page ? ` · page ${x.page}` : ""}
                {x.origin === "authored_context" ? " · authored learning context, not the lecture" : ""}
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      {step && (
        <div className="space-y-3">
          <p className="text-[16px] leading-relaxed" data-testid="activity-prompt">
            <MathText text={step.prompt} />
          </p>
          <p className="text-sm text-muted">{step.expected}</p>
          {step.hints.length > 0 && (
            <div className="space-y-1">
              {step.hints.slice(0, hints).map((h, i) => (
                <p key={i} className="rounded-lg bg-amber-soft px-3 py-2 text-sm text-amber-ink">
                  Hint {i + 1}: <MathText text={h} />
                </p>
              ))}
              {hints < step.hints.length && (
                <button type="button" className="min-h-8 text-sm text-teal underline" onClick={() => setHints((n) => n + 1)}>
                  Show a hint ({step.hints.length - hints} left)
                </button>
              )}
            </div>
          )}
          <label className="block">
            <span className="sr-only">Your response: {step.title}</span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              maxLength={4000}
              data-testid="activity-response"
              className="w-full rounded-[7px] border border-line-strong bg-card px-3 py-2 text-[15px] focus:border-teal focus:outline-none"
              placeholder={step.key === "reconstruct" ? "From memory, in your own words…" : "Your response…"}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={primaryBtn} onClick={submit} disabled={busy} data-testid="activity-submit">
              {busy ? "Saving…" : "Save response"}
            </button>
            <button type="button" className={secondaryBtn} onClick={() => advance("skip")} disabled={busy} data-testid="activity-skip">
              Skip this activity
            </button>
          </div>
        </div>
      )}

      {a.status === "teach" && (
        <div className="space-y-3" data-testid="activity-teaching">
          {a.responses.length > 0 && (
            <div className="rounded-lg bg-paper p-3 text-sm">
              <p className="text-xs font-medium text-muted">What you wrote</p>
              <p className="mt-1 whitespace-pre-wrap">{a.responses[a.responses.length - 1].text}</p>
            </div>
          )}
          {teaching ? (
            <div className="space-y-3 text-[15px]" data-testid="explanation">
              <p className="text-xs font-medium uppercase tracking-[0.06em] text-muted">Checked explanation · compare it with your links</p>
              <p>
                <MathText text={teaching.explanation} />
              </p>
              {teaching.workedExample && (
                <div className="rounded-lg bg-paper p-3">
                  <p className="text-xs font-medium uppercase text-muted">Worked example</p>
                  <MathText text={teaching.workedExample} />
                </div>
              )}
            </div>
          ) : (
            !err && <p className="text-sm text-muted">Loading the explanation…</p>
          )}
          <button type="button" className={primaryBtn} onClick={() => advance("continue")} disabled={busy || !teaching} data-testid="activity-reconstruct">
            Hide the explanation and reconstruct from memory
          </button>
        </div>
      )}

      {done && a.responses.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-teal underline underline-offset-2">Your responses</summary>
          <ul className="mt-2 space-y-2">
            {a.responses.map((r) => (
              <li key={r.stepIndex} className="rounded-lg bg-paper p-3">
                <p className="text-xs font-medium text-muted">{a.steps[r.stepIndex]?.title}</p>
                <p className="mt-1 whitespace-pre-wrap">{r.text}</p>
              </li>
            ))}
          </ul>
        </details>
      )}

      {err && <Notice tone="error">{err}</Notice>}
      <p className="text-xs text-muted">{a.note}</p>
    </section>
  );
}
