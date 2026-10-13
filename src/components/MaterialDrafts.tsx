"use client";

import { useEffect, useState } from "react";
import { Shapes } from "lucide-react";
import type { MaterialDraft } from "@/lib/pacer/materialDrafts";
import { api, ApiError } from "./api";
import { notifyDataChanged } from "./dataEvents";
import { MathText } from "./MathText";
import { Notice, Pill } from "./ui";
import { useApiResource } from "./useApiResource";

interface SkillMaterial {
  skillId: string;
  objective: string;
  unitTitle: string;
  sourcePages: number[];
  hasExplanation: boolean;
  hasQuestion: boolean;
  available: { templateId: string; label: string }[];
  pending: { id: string; status: "draft" | "invalid"; draft: unknown; problems: string[]; providerLabel: string } | null;
  drafting: { status: "queued" | "running" | "failed"; error: string | null } | null;
}

const btn =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-[7px] border border-line-strong bg-card px-3.5 text-sm font-medium text-ink transition-colors hover:border-teal hover:text-teal disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";
const primaryBtn =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-[7px] bg-teal px-3.5 text-sm font-medium text-white transition-colors hover:bg-teal-dark disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";

/**
 * Activity material for an imported topic. The AI drafts it from the approved pages; it is used only once approved.
 * Activities never change levels, so unlike check questions everything is shown for review.
 */
export function MaterialDraftsPanel({ topicId, onChanged }: { topicId: string; onChanged: () => void }) {
  const { data, error, reload } = useApiResource<{ available: boolean; providerMode: "mock" | "live"; skills: SkillMaterial[] }>(
    `/api/topics/${topicId}/activity-drafts`,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const drafting = !!data?.skills.some((s) => s.drafting && s.drafting.status !== "failed");

  useEffect(() => {
    if (!drafting) return;
    const t = setInterval(reload, 2500);
    return () => clearInterval(t);
  }, [drafting, reload]);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!data || !data.available || data.skills.length === 0) return null;

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setErr(null);
    try {
      await fn();
      reload();
      onChanged();
      notifyDataChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Something went wrong. Nothing was changed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="material-title" className="rounded-xl border border-line bg-card p-5 sm:p-6" data-testid="material-drafts">
      <h2 id="material-title" className="flex items-center gap-2 text-[17px] font-semibold tracking-tight">
        <Shapes size={17} aria-hidden="true" /> Learning activities
      </h2>
      <p className="mt-1 max-w-prose text-sm text-muted">
        Prepared activities for each subtopic, such as connecting ideas before an explanation or making a source-linked note. The AI drafts
        them from your PDF pages and you approve them. They shape learning sessions only, never your level.
        {data.providerMode !== "live" && " Offline mode can only prepare the authored activities for the sample lecture."}
      </p>
      {err && <Notice tone="error">{err}</Notice>}
      <ul className="mt-4 space-y-4">
        {data.skills.map((s) => {
          const inProgress = !!s.drafting && s.drafting.status !== "failed";
          return (
            <li key={s.skillId} className="rounded-[10px] border border-line p-4" data-testid={`material-${s.skillId}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold">{s.unitTitle}</p>
                  <p className="text-sm text-muted">{s.objective}</p>
                  <p className="mt-1 flex flex-wrap gap-2 text-xs">
                    {s.available.length === 0 ? (
                      <span className="text-muted">No prepared activities yet</span>
                    ) : (
                      s.available.map((a) => (
                        <Pill key={a.templateId} tone="teal">
                          {a.label}
                        </Pill>
                      ))
                    )}
                    {s.hasExplanation && <Pill>Checked explanation</Pill>}
                  </p>
                  {s.available.length > 0 && !s.hasQuestion && (
                    <p className="mt-1 text-xs text-amber-ink">Activities appear in learning sessions once this subtopic has an approved question.</p>
                  )}
                </div>
                <button
                  type="button"
                  className={btn}
                  disabled={!!busy || inProgress || !!s.pending}
                  onClick={() => run(`gen-${s.skillId}`, () => api(`/api/skills/${s.skillId}/activity-drafts`, { method: "POST" }))}
                  data-testid={`draft-material-${s.skillId}`}
                >
                  {inProgress ? "Drafting…" : s.available.length > 0 ? "Draft again" : "Draft activities"}
                </button>
              </div>
              {inProgress && <p className="mt-2 text-sm text-muted">Drafting from PDF page {s.sourcePages.join(", ")}… This can take up to a minute.</p>}
              {s.drafting?.status === "failed" && <Notice tone="warn">Drafting didn&apos;t finish: {s.drafting.error ?? "unknown error"} You can try again.</Notice>}
              {s.pending && (
                <PendingMaterial
                  pending={s.pending}
                  busy={busy === s.pending.id}
                  disabled={!!busy}
                  onApprove={() => run(s.pending!.id, () => api(`/api/activity-drafts/${s.pending!.id}`, { method: "POST", json: { action: "approve" } }))}
                  onReject={() => run(s.pending!.id, () => api(`/api/activity-drafts/${s.pending!.id}`, { method: "POST", json: { action: "reject" } }))}
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PendingMaterial(props: { pending: NonNullable<SkillMaterial["pending"]>; busy: boolean; disabled: boolean; onApprove: () => void; onReject: () => void }) {
  const { pending: p } = props;
  const d = p.draft as Partial<MaterialDraft>;
  const block = (title: string, body: React.ReactNode) => (
    <div>
      <p className="text-xs font-medium text-muted">{title}</p>
      <div className="mt-0.5">{body}</div>
    </div>
  );
  return (
    <div className="mt-3 space-y-3 rounded-[10px] bg-paper p-4 text-sm" data-testid={`material-draft-${p.id}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Pill tone="info">Draft · not used yet</Pill>
        <span className="text-muted">{p.providerLabel}</span>
      </div>
      {p.status === "invalid" && (
        <Notice tone="warn" title="This draft failed its checks">
          <ul className="list-disc pl-5">
            {p.problems.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </Notice>
      )}
      {d.explanation &&
        block(
          "Teaching explanation (becomes this subtopic's checked explanation)",
          <>
            <MathText text={d.explanation.text} className="block whitespace-pre-wrap" />
            {d.explanation.workedExample && <MathText text={d.explanation.workedExample} className="mt-1 block whitespace-pre-wrap text-muted" />}
          </>,
        )}
      {d.connect &&
        block(
          "Connect and explain",
          <>
            <p>Concepts: {d.connect.concepts.join(" · ")}</p>
            <MathText text={d.connect.prompt} className="block" />
            {d.connect.hints.length > 0 && <p className="text-muted">Hints: {d.connect.hints.join(" / ")}</p>}
            {d.reconstruct && <MathText text={`Then, from memory: ${d.reconstruct.prompt}`} className="mt-1 block" />}
          </>,
        )}
      {d.createAnalogy && block("Make your own comparison", <MathText text={d.createAnalogy.prompt} className="block" />)}
      {d.evidence &&
        block(
          `Claim, support and limits · PDF page ${d.evidence.page}`,
          <>
            <blockquote className="border-l-2 border-line-strong pl-2 text-muted">“{d.evidence.excerpt}”</blockquote>
            <p>Claim: {d.evidence.claim}</p>
            <MathText text={d.evidence.prompt} className="block" />
          </>,
        )}
      {d.reference &&
        block(
          `Capture and locate · PDF page ${d.reference.page}`,
          <>
            <blockquote className="border-l-2 border-line-strong pl-2 text-muted">“{d.reference.excerpt}”</blockquote>
            <MathText text={d.reference.prompt} className="block" />
            {d.reference.recallPrompt && <MathText text={`Recall: ${d.reference.recallPrompt}`} className="block text-muted" />}
          </>,
        )}
      <div className="flex flex-wrap gap-2">
        {p.status === "draft" && (
          <button type="button" className={primaryBtn} disabled={props.disabled} onClick={props.onApprove} data-testid="approve-material">
            Approve
          </button>
        )}
        <button type="button" className={btn} disabled={props.disabled} onClick={props.onReject} data-testid="reject-material">
          Reject
        </button>
        {props.busy && <span className="self-center text-muted">Saving…</span>}
      </div>
    </div>
  );
}
