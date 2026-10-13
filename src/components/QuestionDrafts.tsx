"use client";

import { useState } from "react";
import { Eye, EyeOff, Sparkles } from "lucide-react";
import type { DraftQuestion } from "@/lib/questions/drafts";
import { api, ApiError } from "./api";
import { notifyDataChanged } from "./dataEvents";
import { MathText } from "./MathText";
import { Notice, Pill } from "./ui";
import { useApiResource } from "./useApiResource";

interface PendingDraft {
  id: string;
  status: "draft" | "invalid";
  familyRole: "initial" | "new_context" | null;
  transferChange: string;
  taskType: string | null;
  prompt: string;
  sourcePages: number[];
  problemCount: number;
  answerSeen: boolean;
  answerKey: { question: unknown; problems: string[] } | null;
  edited: boolean;
  providerLabel: string;
}

interface SkillDrafts {
  skillId: string;
  objective: string;
  unitTitle: string;
  sourcePages: number[];
  questions: { id: string; prompt: string; taskType: string; isTransfer: boolean; practiceOnly: boolean; origin: "ai_draft" | "bank"; originLabel: string }[];
  pending: PendingDraft[];
  rejectedCount: number;
}

interface DraftsData {
  available: boolean;
  providerMode: "mock" | "live";
  skills: SkillDrafts[];
}

const btn =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-[7px] border border-line-strong bg-card px-3.5 text-sm font-medium text-ink transition-colors hover:border-teal hover:text-teal disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";
const primaryBtn =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-[7px] bg-teal px-3.5 text-sm font-medium text-white transition-colors hover:bg-teal-dark disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";
const field = "w-full rounded-[7px] border border-line-strong bg-card px-3 py-2 text-sm";

const ROLE_LABEL = { initial: "First question", new_context: "New-context question" } as const;

/**
 * Review of AI-drafted questions for an imported topic. The learner is also the reviewer, so the answer key starts
 * hidden: approving without opening it makes the question usable for no-help checks; opening it limits the question
 * to practice, because a check on an answer you have read is not independent.
 */
export function QuestionDraftsPanel({ topicId, checkInProgress, onChanged }: { topicId: string; checkInProgress: boolean; onChanged: () => void }) {
  const { data, error, reload } = useApiResource<DraftsData>(`/api/topics/${topicId}/question-drafts`);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [confirmReveal, setConfirmReveal] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!data || !data.available || data.skills.length === 0) return null;

  const needsQuestions = data.skills.filter((s) => !s.questions.some((q) => !q.practiceOnly)).length;

  async function run(key: string, fn: () => Promise<unknown>, done?: string) {
    setBusy(key);
    setErr(null);
    setInfo(null);
    try {
      await fn();
      if (done) setInfo(done);
      reload();
      onChanged();
      notifyDataChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Something went wrong. Nothing was changed.");
    } finally {
      setBusy(null);
    }
  }

  const generate = (skillId: string) =>
    run(
      `gen-${skillId}`,
      async () => {
        const res = await api<{ drafted: number; invalid: number; batchProblems: string[] }>(`/api/skills/${skillId}/question-drafts`, { method: "POST" });
        if (res.invalid > 0 || res.batchProblems.length > 0) {
          setErr(`${res.drafted} question${res.drafted === 1 ? "" : "s"} drafted; ${res.invalid} failed the checks${res.batchProblems.length ? ` (${res.batchProblems.join("; ")})` : ""}. You can reject them or draft again.`);
        }
      },
      "Draft questions ready. Approve them before they're used.",
    );
  const act = (draftId: string, json: Record<string, unknown>, done?: string) =>
    run(draftId, () => api(`/api/question-drafts/${draftId}`, { method: "POST", json }), done);

  return (
    <section aria-labelledby="question-drafts-title" className="rounded-xl border border-line bg-card p-5 sm:p-6" data-testid="question-drafts">
      <h2 id="question-drafts-title" className="flex items-center gap-2 text-[17px] font-semibold tracking-tight">
        <Sparkles size={17} aria-hidden="true" /> Check questions
      </h2>
      <p className="mt-1 text-sm text-muted">
        {needsQuestions > 0
          ? `${needsQuestions} subtopic${needsQuestions === 1 ? " needs" : "s need"} a question before you can check yourself without help.`
          : "Every subtopic has a question for no-help checks."}{" "}
        {data.providerMode === "live"
          ? "The AI drafts two questions per subtopic from your approved PDF pages."
          : "Offline mode can only prepare the authored questions for the sample lecture."}
      </p>
      <details className="mt-2 text-sm text-muted">
        <summary className="inline-flex min-h-8 cursor-pointer items-center text-teal underline underline-offset-2">Why the answer key is hidden</summary>
        <p className="mt-1 max-w-prose">
          You&apos;re both the reviewer and the learner. If you read a question&apos;s answer, a later check on it isn&apos;t
          independent. So <strong>Approve for checks</strong> is only offered while the answer key is closed. You&apos;re then
          trusting the AI&apos;s marking scheme, and the question is labelled as an AI draft. Once you open the key, you can
          still edit the question and approve it for practice.
        </p>
      </details>
      {checkInProgress && <Notice tone="warn">A check is open on this topic. Finish it before reviewing new questions.</Notice>}
      {err && <Notice tone="error">{err}</Notice>}
      {info && <Notice tone="good">{info}</Notice>}

      <ul className="mt-4 space-y-4">
        {data.skills.map((s) => {
          const forChecks = s.questions.filter((q) => !q.practiceOnly);
          return (
            <li key={s.skillId} className="rounded-[10px] border border-line p-4" data-testid={`question-drafts-${s.skillId}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold">{s.unitTitle}</p>
                  <p className="text-sm text-muted">{s.objective}</p>
                  <p className="mt-1 flex flex-wrap gap-2 text-xs text-muted">
                    <span>PDF page {s.sourcePages.join(", ")}</span>
                    <span>
                      {forChecks.length} for checks · {s.questions.length - forChecks.length} practice only
                    </span>
                    {s.rejectedCount > 0 && <span>{s.rejectedCount} rejected</span>}
                  </p>
                </div>
                <button type="button" className={btn} disabled={!!busy || checkInProgress} onClick={() => generate(s.skillId)} data-testid={`draft-questions-${s.skillId}`}>
                  {busy === `gen-${s.skillId}` ? "Drafting…" : s.pending.length > 0 || s.questions.length > 0 ? "Draft more" : "Draft questions"}
                </button>
              </div>

              {s.questions.length > 0 && (
                <ul className="mt-3 space-y-1.5">
                  {s.questions.map((q) => (
                    <li key={q.id} className="text-sm">
                      <span className="flex flex-wrap items-center gap-2">
                        <Pill tone={q.practiceOnly ? "neutral" : "good"}>{q.practiceOnly ? "Practice only" : "Used in checks"}</Pill>
                        {q.isTransfer && <Pill>New context</Pill>}
                        <span className="text-xs text-muted">{q.originLabel}</span>
                      </span>
                      <MathText text={q.prompt} className="mt-1 block" />
                    </li>
                  ))}
                </ul>
              )}

              {s.pending.map((d) => (
                <DraftCard
                  key={d.id}
                  draft={d}
                  busy={busy === d.id}
                  disabled={!!busy || checkInProgress}
                  confirmingReveal={confirmReveal === d.id}
                  editing={editing === d.id}
                  onAskReveal={() => setConfirmReveal(d.id)}
                  onCancelReveal={() => setConfirmReveal(null)}
                  onReveal={() => {
                    setConfirmReveal(null);
                    act(d.id, { action: "reveal_key" });
                  }}
                  onApprove={(use) =>
                    act(d.id, { action: "approve", use }, use === "checks" ? "Approved for no-help checks." : "Approved for practice.")
                  }
                  onReject={() => act(d.id, { action: "reject" })}
                  onEdit={() => setEditing(d.id)}
                  onCancelEdit={() => setEditing(null)}
                  onSave={(question) => {
                    setEditing(null);
                    act(d.id, { action: "edit", question }, "Saved your edit.");
                  }}
                />
              ))}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function DraftCard(props: {
  draft: PendingDraft;
  busy: boolean;
  disabled: boolean;
  confirmingReveal: boolean;
  editing: boolean;
  onAskReveal: () => void;
  onCancelReveal: () => void;
  onReveal: () => void;
  onApprove: (use: "checks" | "practice") => void;
  onReject: () => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (q: DraftQuestion) => void;
}) {
  const { draft: d } = props;
  const key = d.answerKey?.question as DraftQuestion | undefined;
  return (
    <div className="mt-3 rounded-[10px] bg-paper p-4" data-testid={`draft-${d.id}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Pill tone="info">Draft · not used yet</Pill>
        {d.familyRole && <Pill>{ROLE_LABEL[d.familyRole]}</Pill>}
        {d.taskType && <span className="text-muted">{d.taskType}</span>}
        {d.sourcePages.length > 0 && <span className="text-muted">PDF page {d.sourcePages.join(", ")}</span>}
        <span className="text-muted">{d.providerLabel}</span>
        {d.edited && <span className="text-muted">Edited by you</span>}
        {d.status === "invalid" && <Pill tone="warn">{d.problemCount} problem{d.problemCount === 1 ? "" : "s"}: open the key to fix</Pill>}
      </div>
      <MathText text={d.prompt} className="mt-2 block text-sm" />
      {d.familyRole === "new_context" && d.transferChange && <p className="mt-1 text-xs text-muted">What changes: {d.transferChange}</p>}

      {props.confirmingReveal && (
        <Notice tone="warn" title="Open the answer key?">
          After you&apos;ve seen the answer, this question can only be approved for practice. It won&apos;t count towards no-help checks.
          <span className="mt-2 flex flex-wrap gap-2">
            <button type="button" className={btn} onClick={props.onReveal} data-testid="confirm-reveal">
              Open the key
            </button>
            <button type="button" className={btn} onClick={props.onCancelReveal}>
              Keep it closed
            </button>
          </span>
        </Notice>
      )}

      {key && !props.editing && <AnswerKey question={key} problems={d.answerKey!.problems} />}
      {key && props.editing && <DraftEditor question={key} onCancel={props.onCancelEdit} onSave={props.onSave} />}

      {!props.editing && (
        <div className="mt-3 flex flex-wrap gap-2">
          {!d.answerSeen && d.status === "draft" && (
            <button type="button" className={primaryBtn} disabled={props.disabled} onClick={() => props.onApprove("checks")} data-testid="approve-checks">
              Approve for checks
            </button>
          )}
          {d.answerSeen && d.status === "draft" && (
            <button type="button" className={primaryBtn} disabled={props.disabled} onClick={() => props.onApprove("practice")} data-testid="approve-practice">
              Approve for practice
            </button>
          )}
          {!d.answerSeen ? (
            <button type="button" className={btn} disabled={props.disabled} onClick={props.onAskReveal} data-testid="reveal-key">
              <Eye size={15} aria-hidden="true" /> Open answer key
            </button>
          ) : (
            <button type="button" className={btn} disabled={props.disabled} onClick={props.onEdit}>
              Edit
            </button>
          )}
          <button type="button" className={btn} disabled={props.disabled} onClick={props.onReject} data-testid="reject-draft">
            Reject
          </button>
          {props.busy && <span className="self-center text-sm text-muted">Saving…</span>}
          {!d.answerSeen && (
            <span className="flex items-center gap-1 self-center text-xs text-muted">
              <EyeOff size={13} aria-hidden="true" /> Answer key closed
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function AnswerKey({ question: q, problems }: { question: DraftQuestion; problems: string[] }) {
  return (
    <div className="mt-3 space-y-3 border-t border-line pt-3 text-sm" data-testid="answer-key">
      {problems.length > 0 && (
        <Notice tone="warn" title="Fix before approving">
          <ul className="list-disc pl-5">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Notice>
      )}
      <div>
        <p className="text-xs font-medium text-muted">Reference answer</p>
        <MathText text={q.referenceSummary ?? ""} className="block" />
      </div>
      <div>
        <p className="text-xs font-medium text-muted">Marking criteria</p>
        <ul className="mt-1 space-y-1">
          {(q.criteria ?? []).map((c) => (
            <li key={c.id}>
              <MathText text={c.description} />{" "}
              <span className="text-xs text-muted">
                {c.essential ? "essential" : "optional"}
                {c.fatalIfNotMet ? " · disqualifying if missed" : ""}
                {q.numericChecks?.filter((n) => n.criterionId === c.id).map((n) => ` · ${n.value} ± ${n.tolerance}`)}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <p className="text-xs font-medium text-muted">Hints</p>
        <ol className="mt-1 list-decimal space-y-1 pl-5">
          {(q.hints ?? []).map((h, i) => (
            <li key={i}>
              <MathText text={h} />
            </li>
          ))}
        </ol>
      </div>
      <div>
        <p className="text-xs font-medium text-muted">Example answers</p>
        <ul className="mt-1 space-y-1">
          {(q.examples ?? []).map((e, i) => (
            <li key={i}>
              <span className="text-xs text-muted">{e.label} → {e.expectedOutcome}: </span>
              <MathText text={e.answer} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Edits the text and marking of a draft. The server re-runs every check on save. */
function DraftEditor({ question, onCancel, onSave }: { question: DraftQuestion; onCancel: () => void; onSave: (q: DraftQuestion) => void }) {
  const [q, setQ] = useState<DraftQuestion>(question);
  const set = <K extends keyof DraftQuestion>(k: K, v: DraftQuestion[K]) => setQ((prev) => ({ ...prev, [k]: v }));
  return (
    <form
      className="mt-3 space-y-3 border-t border-line pt-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(q);
      }}
    >
      <label className="block">
        <span className="text-xs font-medium text-muted">Question</span>
        <textarea className={field} rows={3} value={q.prompt} onChange={(e) => set("prompt", e.target.value)} />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-muted">Reference answer</span>
        <textarea className={field} rows={3} value={q.referenceSummary} onChange={(e) => set("referenceSummary", e.target.value)} />
      </label>
      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-muted">Marking criteria</legend>
        {q.criteria.map((c, i) => (
          <div key={c.id} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <input
              className={field}
              value={c.description}
              aria-label={`Criterion ${i + 1}`}
              onChange={(e) => set("criteria", q.criteria.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))}
            />
            <span className="flex flex-wrap items-center gap-3 text-xs">
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={c.essential} onChange={(e) => set("criteria", q.criteria.map((x, j) => (j === i ? { ...x, essential: e.target.checked } : x)))} />
                essential
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={c.fatalIfNotMet} onChange={(e) => set("criteria", q.criteria.map((x, j) => (j === i ? { ...x, fatalIfNotMet: e.target.checked } : x)))} />
                disqualifying
              </label>
              {q.criteria.length > 1 && (
                <button
                  type="button"
                  className="text-teal underline"
                  onClick={() => {
                    set("criteria", q.criteria.filter((_, j) => j !== i));
                    set("numericChecks", q.numericChecks.filter((n) => n.criterionId !== c.id));
                  }}
                >
                  remove
                </button>
              )}
            </span>
          </div>
        ))}
      </fieldset>
      {q.numericChecks.map((n, i) => (
        <div key={n.criterionId} className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted">Expected value ({n.criterionId})</span>
          <input
            className={`${field} w-32`}
            type="number"
            step="any"
            value={n.value}
            onChange={(e) => set("numericChecks", q.numericChecks.map((x, j) => (j === i ? { ...x, value: Number(e.target.value) } : x)))}
          />
          <span className="text-muted">±</span>
          <input
            className={`${field} w-24`}
            type="number"
            step="any"
            min="0"
            value={n.tolerance}
            onChange={(e) => set("numericChecks", q.numericChecks.map((x, j) => (j === i ? { ...x, tolerance: Number(e.target.value) } : x)))}
          />
        </div>
      ))}
      {q.hints.map((h, i) => (
        <label key={i} className="block">
          <span className="text-xs font-medium text-muted">{i === 0 ? "Hint 1 (general cue)" : "Hint 2 (worked step)"}</span>
          <textarea className={field} rows={2} value={h} onChange={(e) => set("hints", q.hints.map((x, j) => (j === i ? e.target.value : x)))} />
        </label>
      ))}
      <div className="flex gap-2">
        <button type="submit" className={primaryBtn}>
          Save edit
        </button>
        <button type="button" className={btn} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
