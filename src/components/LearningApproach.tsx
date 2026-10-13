"use client";

import { useState } from "react";
import { CircleHelp } from "lucide-react";
import { DEFAULT_TEMPLATE, TEMPLATE_LABEL } from "@/lib/pacer/registry";
import { PACER_DEFINITION, PACER_LABEL, PACER_TYPES, mixedText, type PacerType } from "@/lib/pacer/taxonomy";
import { api, ApiError } from "./api";
import { notifyDataChanged } from "./dataEvents";
import { Notice, Pill } from "./ui";

export interface ApproachSummary {
  skillId: string;
  unitId: string;
  objective: string;
  label: string;
  /** The learner's own familiar connection, if supplied. */
  learnerConnection: string | null;
  status: "none" | "draft" | "accepted" | "edited" | "dismissed" | "stale" | "abstained" | "error" | "invalid";
  effective: {
    decisionId: string;
    status: "accepted" | "edited" | "dismissed";
    chosenByYou: boolean;
    primary: PacerType | null;
    secondary: PacerType[];
    primaryLabel: string | null;
    stale: boolean;
  } | null;
  route: { primaryLabel: string; primaryAvailable: boolean; secondaryLabel: string | null } | null;
  draft: { proposalId: string; kind: "suggestion" | "abstain"; primary?: PacerType; secondary?: PacerType[]; abstainText: string | null; providerLabel: string } | null;
  failure: { kind: string; message: string } | null;
}

interface ProposalDetail {
  proposalId: string;
  providerLabel: string;
  kind: "suggestion" | "abstain";
  primary?: PacerType;
  secondary?: PacerType[];
  mixed?: string | null;
  rationale?: string;
  ambiguityNote?: string | null;
  support?: { from: string; quote: string; where: string }[];
  abstainText?: string;
  message?: string;
}

interface SkillDetail extends ApproachSummary {
  draftDetail: ProposalDetail | null;
  effectiveDetail: { reason: string | null; reasonSupplied: boolean; proposal: ProposalDetail | null } | null;
  failureDetail: { problems: string[] } | null;
}

const btn =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-[7px] border border-line-strong bg-card px-3.5 text-sm font-medium text-ink transition-colors hover:border-teal hover:text-teal disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";
const primaryBtn =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-[7px] bg-teal px-3.5 text-sm font-medium text-white transition-colors hover:bg-teal-dark disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";

const typeWithActivity = (t: PacerType) => `${PACER_LABEL[t]} · ${TEMPLATE_LABEL[DEFAULT_TEMPLATE[t]]}`;

/** One-line state for a skill. Badges only: no rationale or quotes. */
function statusLine(s: ApproachSummary): { text: string; tone: "neutral" | "info" | "good" | "warn" | "teal"; note?: string } {
  if (s.status === "stale") return { text: "Needs review", tone: "warn", note: "The source or context changed since this was chosen. Ordinary learning is used until you review it." };
  if (s.status === "draft" && s.draft?.primary) {
    return { text: `Suggested: ${typeWithActivity(s.draft.primary)}`, tone: "info", note: "Review this suggestion before using it in your learning session." };
  }
  if (s.status === "abstained") return { text: "More context needed", tone: "neutral", note: "More context needed. You can choose an approach yourself." };
  if (s.effective && s.effective.status !== "dismissed" && s.effective.primary) {
    const base = `${PACER_LABEL[s.effective.primary]} · ${s.route?.primaryLabel ?? ""}`;
    return {
      text: base,
      tone: "teal",
      note: s.route && !s.route.primaryAvailable ? "No prepared activity for this approach. Ordinary learning continues." : s.route?.secondaryLabel ? `Optional: ${s.route.secondaryLabel}` : undefined,
    };
  }
  if (s.effective?.status === "dismissed") return { text: "Ordinary learning", tone: "neutral", note: "Suggestion dismissed." };
  if (s.status === "error") return { text: "Suggestion failed", tone: "warn", note: `${s.failure?.message} You can retry; ordinary learning is unaffected.` };
  if (s.status === "invalid") return { text: "Not classified", tone: "warn", note: `${s.failure?.message} You can choose an approach yourself.` };
  return { text: "Choose a learning approach", tone: "neutral" };
}

export function LearningApproachPanel({
  topicId,
  skills,
  checkInProgress,
  onChanged,
}: {
  topicId: string;
  skills: ApproachSummary[];
  /** A check is open on this topic: details count as help for it. */
  checkInProgress: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, SkillDetail> | null>(null);
  const [confirmDetails, setConfirmDetails] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  const anyProposal = skills.some((s) => s.draft || s.effective?.status === "accepted" || s.failure);

  async function classify(regenerate: boolean) {
    setBusy("classify");
    setErr(null);
    setInfo(null);
    try {
      const res = await api<{ classified: number; reused: string[]; skipped: { skillId: string }[]; providerError: { message: string } | null }>(`/api/topics/${topicId}/classify`, {
        method: "POST",
        json: { regenerate },
      });
      if (res.providerError) setErr(`The provider failed: ${res.providerError.message} Saved choices are unchanged.`);
      else if (res.skipped.length > 0) setErr(`${res.skipped.length} objective${res.skipped.length === 1 ? " has" : "s have"} too much source text to classify and ${res.skipped.length === 1 ? "is" : "are"} marked below. The others were classified.`);
      else setInfo(res.classified === 0 ? "Nothing changed since the last suggestions, so the saved ones were kept." : "Suggestions ready. Review them before they are used.");
      setDetails(null);
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not suggest approaches.");
    } finally {
      setBusy(null);
    }
  }

  async function loadDetails() {
    setBusy("details");
    setErr(null);
    try {
      const res = await api<{ skills: SkillDetail[] }>(`/api/topics/${topicId}/approach-details`, { method: "POST", json: {} });
      setDetails(Object.fromEntries(res.skills.map((s) => [s.skillId, s])));
      setConfirmDetails(false);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not load the suggestions.");
    } finally {
      setBusy(null);
    }
  }

  async function decide(skill: ApproachSummary, body: Record<string, unknown>) {
    setBusy(skill.skillId);
    setErr(null);
    try {
      await api(`/api/skills/${skill.skillId}/approach`, {
        method: "POST",
        json: { replacesDecisionId: skill.effective?.decisionId ?? null, ...body },
      });
      setEditing(null);
      notifyDataChanged();
      onChanged();
      if (details) await loadDetails();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not save your choice.");
    } finally {
      setBusy(null);
    }
  }

  async function acceptAll() {
    if (!details) return;
    const ids = Object.values(details)
      .map((d) => d.draftDetail)
      .filter((d): d is ProposalDetail => !!d && d.kind === "suggestion")
      .map((d) => d.proposalId);
    setBusy("all");
    setErr(null);
    try {
      await api(`/api/topics/${topicId}/accept-all`, { method: "POST", json: { proposalIds: ids } });
      notifyDataChanged();
      onChanged();
      await loadDetails();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not accept the suggestions.");
    } finally {
      setBusy(null);
    }
  }

  const displayedDrafts = details ? Object.values(details).filter((d) => d.draftDetail?.kind === "suggestion").length : 0;

  return (
    <section aria-labelledby="approach-title" className="rounded-xl border border-line bg-card p-5 sm:p-6" data-testid="learning-approach" aria-busy={busy === "classify"}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="approach-title" className="text-[17px] font-semibold tracking-tight">
            Learning approach
          </h2>
          <p className="mt-1 max-w-[60ch] text-sm text-muted">
            How to study each skill: connect ideas, practise a method, or keep a reference. Suggestions only shape learning sessions; they
            don&apos;t change checks, levels or review dates.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btn} onClick={() => setHelpOpen((o) => !o)} aria-expanded={helpOpen} aria-controls="pacer-help">
            <CircleHelp size={15} aria-hidden="true" />
            About these types
          </button>
          <button type="button" className={primaryBtn} onClick={() => classify(anyProposal)} disabled={busy !== null} data-testid="classify">
            {busy === "classify" ? "Suggesting…" : anyProposal ? "Suggest again" : "Suggest approaches"}
          </button>
        </div>
      </div>

      <div id="pacer-help" hidden={!helpOpen} className="mt-4 rounded-[10px] bg-paper p-4 text-sm">
        <dl className="grid gap-2 sm:grid-cols-2">
          {PACER_TYPES.map((t) => (
            <div key={t}>
              <dt className="font-medium">{PACER_LABEL[t]}</dt>
              <dd className="text-muted">
                {PACER_DEFINITION[t].definition} {PACER_DEFINITION[t].boundary}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-muted">
          Adapted from PACER, introduced by Justin Sung. These types describe the material and how you use it for this objective. They are
          not a learning style, a level or a measure of mastery, and no learning gain is claimed.
        </p>
      </div>

      <div aria-live="polite" className="mt-3 space-y-2">
        {err && <Notice tone="error">{err}</Notice>}
        {info && <Notice tone="good">{info}</Notice>}
      </div>

      <ul className="mt-4 divide-y divide-line rounded-[10px] border border-line">
        {skills.map((s) => {
          const line = statusLine(s);
          const d = details?.[s.skillId] ?? null;
          return (
            <li key={s.skillId} className="px-4 py-3" data-testid={`approach-${s.skillId}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[15px] font-medium">{s.label}</p>
                  <p className="text-xs text-muted">{s.objective}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone={line.tone}>{line.text}</Pill>
                  {s.effective?.chosenByYou && s.effective.status !== "dismissed" && <Pill>Chosen by you</Pill>}
                </div>
              </div>
              {line.note && <p className="mt-1 text-xs text-muted">{line.note}</p>}

              {d && <DetailBlock d={d} />}

              <ConnectionEditor
                skillId={s.skillId}
                saved={s.learnerConnection}
                disabled={busy !== null}
                onSaved={() => {
                  setDetails(null);
                  notifyDataChanged();
                  onChanged();
                }}
              />

              {editing === s.skillId ? (
                <EditForm
                  initial={s.draft?.primary ? { primary: s.draft.primary, secondary: s.draft.secondary ?? [] } : s.effective?.primary ? { primary: s.effective.primary, secondary: s.effective.secondary } : null}
                  busy={busy === s.skillId}
                  onCancel={() => setEditing(null)}
                  onSave={(primary, secondary, reason) => decide(s, { action: "edit", proposalId: s.draft?.proposalId ?? null, primary, secondary, reason })}
                />
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  {d && s.draft?.kind === "suggestion" && (
                    <button type="button" className={primaryBtn} disabled={busy !== null} onClick={() => decide(s, { action: "accept", proposalId: s.draft!.proposalId })} data-testid={`accept-${s.skillId}`}>
                      Accept
                    </button>
                  )}
                  <button type="button" className={btn} disabled={busy !== null} onClick={() => setEditing(s.skillId)} data-testid={`edit-${s.skillId}`}>
                    {s.draft?.kind === "suggestion" ? "Edit" : "Choose an approach"}
                  </button>
                  {(s.draft || (s.effective && s.effective.status !== "dismissed")) && (
                    <button type="button" className={btn} disabled={busy !== null} onClick={() => decide(s, { action: "dismiss", proposalId: s.draft?.proposalId ?? null })} data-testid={`dismiss-${s.skillId}`}>
                      Dismiss
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {anyProposal && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {!details && !confirmDetails && (
            <button type="button" className={btn} onClick={() => (checkInProgress ? setConfirmDetails(true) : loadDetails())} disabled={busy !== null} data-testid="review-suggestions">
              {busy === "details" ? "Loading…" : "Review suggestions and reasons"}
            </button>
          )}
          {confirmDetails && (
            <Notice tone="warn" title="A check on this topic is in progress">
              The reasons and quotes can give away answers, so opening them counts as help in that check.{" "}
              <button type="button" className="underline" onClick={loadDetails}>
                Open anyway
              </button>{" "}
              ·{" "}
              <button type="button" className="underline" onClick={() => setConfirmDetails(false)}>
                Not now
              </button>
            </Notice>
          )}
          {details && displayedDrafts > 1 && (
            <button type="button" className={primaryBtn} onClick={acceptAll} disabled={busy !== null} data-testid="accept-all">
              Accept all {displayedDrafts} suggestions
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function DetailBlock({ d }: { d: SkillDetail }) {
  const p = d.draftDetail ?? d.effectiveDetail?.proposal ?? null;
  return (
    <div className="mt-2 space-y-2 rounded-lg bg-paper p-3 text-sm" data-testid={`approach-detail-${d.skillId}`}>
      {p?.kind === "suggestion" && (
        <>
          <p className="font-medium">
            {d.draftDetail ? "Suggested" : "Accepted"}: {typeWithActivity(p.primary!)}.
          </p>
          {p.mixed && <p>{p.mixed}</p>}
          <p>{p.rationale}</p>
          {p.ambiguityNote && <p className="text-muted">{p.ambiguityNote}</p>}
          <details>
            <summary className="cursor-pointer text-xs text-teal underline underline-offset-2">Source support</summary>
            <ul className="mt-1 space-y-1">
              {p.support!.map((x, i) => (
                <li key={i} className="text-xs">
                  “{x.quote}” <span className="text-muted">({x.where})</span>
                </li>
              ))}
            </ul>
          </details>
          <p className="text-xs text-muted">{p.providerLabel}</p>
        </>
      )}
      {p?.kind === "abstain" && (
        <>
          <p>{p.abstainText} You can choose an approach yourself.</p>
          <p className="text-muted">{p.message}</p>
          <p className="text-xs text-muted">{p.providerLabel}</p>
        </>
      )}
      {d.effectiveDetail && d.effective?.chosenByYou && (
        <p className="text-xs text-muted">Chosen by you. {d.effectiveDetail.reasonSupplied ? `Your reason: ${d.effectiveDetail.reason}` : "No reason given."}</p>
      )}
      {d.failureDetail && <p className="text-xs text-amber-ink">Rejected: {d.failureDetail.problems.slice(0, 3).join("; ")}</p>}
      {!p && !d.failureDetail && !d.effectiveDetail && <p className="text-muted">No suggestion yet.</p>}
    </div>
  );
}

function EditForm({
  initial,
  busy,
  onSave,
  onCancel,
}: {
  initial: { primary: PacerType; secondary: PacerType[] } | null;
  busy: boolean;
  onSave: (primary: PacerType, secondary: PacerType[], reason: string | null) => void;
  onCancel: () => void;
}) {
  const [primary, setPrimary] = useState<PacerType>(initial?.primary ?? "conceptual");
  const [secondary, setSecondary] = useState<PacerType[]>(initial?.secondary ?? []);
  const [reason, setReason] = useState("");
  const toggle = (t: PacerType) => setSecondary((s) => (s.includes(t) ? s.filter((x) => x !== t) : [...s, t]));
  const mixed = mixedText(primary, secondary.filter((t) => t !== primary));
  return (
    <form
      className="mt-3 space-y-3 rounded-lg border border-line p-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(primary, secondary.filter((t) => t !== primary), reason.trim() || null);
      }}
    >
      <label className="block text-sm">
        <span className="font-medium">Main type</span>
        <select
          className="mt-1 block min-h-10 w-full rounded-[7px] border border-line-strong bg-card px-2 text-sm sm:w-auto"
          value={primary}
          onChange={(e) => setPrimary(e.target.value as PacerType)}
          data-testid="edit-primary"
        >
          {PACER_TYPES.map((t) => (
            <option key={t} value={t}>
              {typeWithActivity(t)}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="text-sm">
        <legend className="font-medium">Also (up to two)</legend>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {PACER_TYPES.filter((t) => t !== primary).map((t) => (
            <label key={t} className="inline-flex min-h-8 items-center gap-2">
              <input type="checkbox" checked={secondary.includes(t)} disabled={!secondary.includes(t) && secondary.filter((x) => x !== primary).length >= 2} onChange={() => toggle(t)} />
              {PACER_LABEL[t]}
            </label>
          ))}
        </div>
      </fieldset>
      {mixed && <p className="text-xs text-muted">{mixed}</p>}
      <label className="block text-sm">
        <span className="font-medium">Reason (optional)</span>
        <input
          className="mt-1 block min-h-10 w-full rounded-[7px] border border-line-strong bg-card px-2 text-sm"
          maxLength={300}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={primaryBtn} disabled={busy} data-testid="edit-save">
          {busy ? "Saving…" : "Use this approach"}
        </button>
        <button type="button" className={btn} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * The learner's own familiar connection ("this reminds me of ..."). Never inferred: only what the learner writes. It
 * feeds the next suggestion and, when the lecture has no comparison of its own, a "Map and critique" activity.
 */
function ConnectionEditor({ skillId, saved, disabled, onSaved }: { skillId: string; saved: string | null; disabled: boolean; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(saved ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save(value: string) {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/skills/${skillId}/connection`, { method: "POST", json: { text: value } });
      setOpen(false);
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not save your connection.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <p className="mt-2 text-xs text-muted">
        {saved ? (
          <>
            Your connection: <span className="text-ink">“{saved}”</span>{" "}
          </>
        ) : null}
        <button
          type="button"
          className="text-teal underline underline-offset-2"
          disabled={disabled}
          onClick={() => {
            setText(saved ?? "");
            setOpen(true);
          }}
          data-testid={`connection-${skillId}`}
        >
          {saved ? "Change" : "Add something this reminds you of"}
        </button>
      </p>
    );
  }
  return (
    <form
      className="mt-2 space-y-2 rounded-lg border border-line p-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        save(text);
      }}
    >
      <label className="block">
        <span className="font-medium">Something this reminds you of (optional)</span>
        <span className="block text-xs text-muted">
          A familiar idea, from another course or everyday life. It shapes the next suggestion, and you can then map and critique it as a
          learning activity. Changing it means saved approaches are reviewed again.
        </span>
        <textarea
          className="mt-1 w-full rounded-[7px] border border-line-strong bg-card px-3 py-2 text-sm"
          rows={2}
          maxLength={500}
          value={text}
          onChange={(e) => setText(e.target.value)}
          data-testid={`connection-text-${skillId}`}
        />
      </label>
      {err && <Notice tone="error">{err}</Notice>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={primaryBtn} disabled={busy} data-testid={`connection-save-${skillId}`}>
          {busy ? "Saving…" : "Save"}
        </button>
        {saved && (
          <button type="button" className={btn} disabled={busy} onClick={() => save("")}>
            Remove
          </button>
        )}
        <button type="button" className={btn} disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
