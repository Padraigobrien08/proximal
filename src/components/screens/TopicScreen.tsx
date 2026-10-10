"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { BookOpenText, CircleHelp, ClipboardCheck, FileText, RotateCcw } from "lucide-react";
import { formatDateTime } from "@/lib/domain/labels";
import type { EvidenceState } from "@/lib/domain/types";
import { api, ApiError } from "../api";
import { CriterionFeedback, type FeedbackData } from "../CriterionFeedback";
import { EvidenceLabel } from "../EvidenceLabel";
import { FlagJudgementButton } from "../FlagDialog";
import { HistoricalReplay } from "../HistoricalReplay";
import type { ProviderInfo } from "../ProviderBadge";
import { useApiResource } from "../useApiResource";
import { ProviderNotice } from "../workspace";
import { Notice, Pill } from "../ui";

const TZ = "Europe/London";

interface SkillRow {
  id: string;
  unitId: string;
  objective: string;
  required: boolean;
  evidenceState: EvidenceState;
  reassessmentNeeded: boolean;
  lastIndependentAt: number | null;
  lastIndependentOutcome: string | null;
  dueWhen: string | null;
  dueExact: string | null;
  freshnessLabel: string | null;
  isDue: boolean;
  coverageNote: string;
  reviewAvailable: boolean;
  applicationSkill: boolean;
  checkInProgress: boolean;
  questionStatuses: string[];
}

type HistoryRow =
  | {
      kind: "attempt";
      at: number;
      attemptId: string;
      sessionId: string;
      skillId: string;
      questionId: string;
      isTransfer: boolean;
      stage: string;
      answer: string;
      resultLabel: string;
      evidenceKind: "pending" | "independent" | "supported";
      assessmentId: string | null;
      excluded: boolean;
      excludedReason: string | null;
      providerLabel: string | null;
      feedback: FeedbackData | null;
    }
  | { kind: "help"; at: number; id: string; label: string; skillIds: string[] };

interface TopicData {
  provider: ProviderInfo;
  topic: { id: string; title: string };
  course: { id: string; title: string; isDemo: boolean; status: string };
  source: { id: string; label: string } | null;
  units: { id: string; title: string; objective: string; sourcePages: number[] }[];
  skills: SkillRow[];
  reviewAvailable: boolean;
  learnAvailable: boolean;
  primaryAction: "learn" | "check" | "review";
  activeSessions: { id: string; mode: string; purpose: string; phase: string; startedAt: string }[];
  history: HistoryRow[];
}

const PURPOSE_TEXT: Record<string, string> = {
  learn: "learning session",
  practice: "supported practice",
  check: "independent check",
  review: "review",
};

export function TopicScreen({ topicId }: { topicId: string }) {
  const router = useRouter();
  const { data, error, reload } = useApiResource<TopicData>(`/api/topics/${topicId}`);
  const [starting, setStarting] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function start(purpose: "learn" | "check" | "review") {
    setStarting(purpose);
    setActionError(null);
    try {
      const res = await api<{ sessionId: string }>("/api/sessions", { method: "POST", json: { topicId, purpose } });
      router.push(`/sessions/${res.sessionId}`);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not start the session.");
      setStarting(null);
    }
  }

  if (error && !data) {
    return (
      <Notice tone="error" title="We couldn't load this topic.">
        {error}{" "}
        <button type="button" className="underline" onClick={reload}>
          Retry
        </button>
      </Notice>
    );
  }
  if (!data) return <div aria-busy="true" className="h-[320px] rounded-xl border border-line bg-card" />;

  const skillById = new Map(data.skills.map((s) => [s.id, s]));
  const pages = [...new Set(data.units.flatMap((u) => u.sourcePages))].sort((a, b) => a - b);
  const required = data.skills.filter((s) => s.required);
  const optional = data.skills.filter((s) => !s.required);
  const anyFixture = data.skills.some((s) => s.questionStatuses.includes("authored_fixture"));
  const dueSkills = data.skills.filter((s) => s.isDue && s.reviewAvailable);

  const actions = [
    {
      key: "learn" as const,
      label: "Learn",
      Icon: BookOpenText,
      hint: "Explanation first, then practice with feedback. Counts as supported.",
      disabled: !data.learnAvailable,
      reason: "No practice questions or tutor are available for this topic in offline mode.",
    },
    {
      key: "check" as const,
      label: "Check understanding",
      Icon: ClipboardCheck,
      hint: "Answer without hints or notes. Feedback comes after all answers are saved.",
      disabled: !data.reviewAvailable,
      reason: "Reviewed assessment questions needed.",
    },
    ...(dueSkills.length > 0
      ? [
          {
            key: "review" as const,
            label: "Review",
            Icon: RotateCcw,
            hint: `Scheduled check due for ${dueSkills.length === 1 ? "one skill" : `${dueSkills.length} skills`}.`,
            disabled: false,
            reason: "",
          },
        ]
      : []),
  ].sort((a, b) => (a.key === data.primaryAction ? -1 : b.key === data.primaryAction ? 1 : 0));

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/courses/${data.course.id}`} className="text-sm text-teal hover:underline">
          ← {data.course.title}
        </Link>
        <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight sm:text-[30px]">{data.topic.title}</h1>
        <p className="mt-1 text-[15px] text-muted">
          {required.length === 1 ? "One required skill" : `${required.length} required skills`}, tracked separately.
          {data.source && (
            <>
              {" "}
              Source: {data.source.label}, PDF page{pages.length === 1 ? "" : "s"} {pages.join(", ")}.
            </>
          )}
        </p>
      </div>

      <ProviderNotice provider={data.provider} />

      {data.activeSessions.length > 0 && (
        <Notice title="Unfinished session">
          <ul className="space-y-1">
            {data.activeSessions.map((s) => (
              <li key={s.id}>
                <Link className="underline" href={`/sessions/${s.id}`}>
                  Resume your {PURPOSE_TEXT[s.purpose] ?? "session"} started {s.startedAt}
                </Link>
              </li>
            ))}
          </ul>
        </Notice>
      )}

      <section aria-label="Study options" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {actions.map((a, i) => (
          <div key={a.key} className="flex flex-col gap-2 rounded-[10px] border border-line bg-card p-4">
            <button
              type="button"
              onClick={() => start(a.key)}
              disabled={a.disabled || starting !== null}
              data-testid={a.key === "learn" ? "start-learn" : a.key === "check" ? "start-review" : "start-due-review"}
              className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-[7px] px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none ${
                i === 0 ? "bg-teal text-white hover:bg-teal-dark" : "border border-line-strong bg-card text-ink hover:border-teal hover:text-teal"
              }`}
            >
              <a.Icon size={16} aria-hidden="true" />
              {starting === a.key ? "Starting…" : a.label}
            </button>
            <p className="text-xs text-muted">{a.disabled ? a.reason : a.hint}</p>
          </div>
        ))}
      </section>
      {actionError && <Notice tone="error">{actionError}</Notice>}
      {!data.reviewAvailable && (
        <Notice tone="warn">
          Independent checks are disabled until an owner-authored, reviewed question bank is attached (see the README:
          <code className="mx-1">npm run questions:import</code>). Imported objectives are never mapped to demo questions.
        </Notice>
      )}
      <p className="flex items-start gap-2 text-xs text-muted">
        <CircleHelp size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
        The app can&apos;t see other tabs or notes, so an independent check relies on you to declare outside help.
        {anyFixture && " Questions here are authored fixtures that the owner has not yet reviewed."}
      </p>

      <section aria-labelledby="skills-title">
        <h2 id="skills-title" className="mb-3 text-[17px] font-semibold tracking-tight">
          Skills
        </h2>
        <ul className="space-y-3">
          {required.map((s) => (
            <SkillEvidenceRow key={s.id} skill={s} unit={data.units.find((u) => u.id === s.unitId)} />
          ))}
        </ul>
        {optional.length > 0 && (
          <>
            <h3 className="mb-2 mt-5 text-sm font-semibold text-muted">Optional extensions</h3>
            <ul className="space-y-3">
              {optional.map((s) => (
                <SkillEvidenceRow key={s.id} skill={s} unit={data.units.find((u) => u.id === s.unitId)} />
              ))}
            </ul>
          </>
        )}
      </section>

      <section aria-labelledby="history-title">
        <h2 id="history-title" className="mb-3 text-[17px] font-semibold tracking-tight">
          Evidence history
        </h2>
        {data.history.length === 0 ? (
          <p className="rounded-[10px] border border-line bg-card p-4 text-sm text-muted">No answers recorded yet.</p>
        ) : (
          <ol className="overflow-hidden rounded-[10px] border border-line bg-card" data-testid="evidence-list">
            {data.history.map((h) =>
              h.kind === "help" ? (
                <li key={h.id} className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5 text-xs text-muted last:border-b-0">
                  <FileText size={14} aria-hidden="true" />
                  <span>{formatDateTime(h.at, TZ)}</span>
                  <span className="font-medium text-amber-ink">{h.label}</span>
                  <span>· support recorded for {h.skillIds.map((id) => skillById.get(id)?.objective ?? id).join("; ")}</span>
                </li>
              ) : (
                <AttemptHistoryRow key={h.attemptId} row={h} objective={skillById.get(h.skillId)?.objective ?? h.skillId} onChanged={reload} />
              ),
            )}
          </ol>
        )}
      </section>

      {data.course.isDemo && data.topic.id === "demo-topic-bce" && (
        <section aria-labelledby="replay-title" className="rounded-xl border border-line bg-card p-5">
          <h2 id="replay-title" className="text-[17px] font-semibold tracking-tight">
            What a later review looks like
          </h2>
          <p className="mt-1 text-sm text-muted">
            Real reviews need at least 24 elapsed hours. This seeded example applies the same rules to recorded example dates.
          </p>
          <div className="mt-3">
            <HistoricalReplay />
          </div>
        </section>
      )}
    </div>
  );
}

function SkillEvidenceRow({ skill: s, unit }: { skill: SkillRow; unit?: { title: string; sourcePages: number[] } }) {
  return (
    <li className="rounded-[10px] border border-line bg-card p-4" data-testid={`skill-${s.id}`}>
      {unit && <p className="text-xs text-muted">{unit.title} · PDF page {unit.sourcePages.join(", ")}</p>}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <span className="text-[15px] font-medium">{s.objective}</span>
        {s.checkInProgress ? <Pill>Check in progress</Pill> : <EvidenceLabel state={s.evidenceState} />}
        {s.reassessmentNeeded && !s.checkInProgress && (
          <Pill tone="warn">{s.applicationSkill ? "Application needs another check" : "Needs another check"}</Pill>
        )}
      </div>
      <p className="mt-1.5 text-sm text-muted">{s.checkInProgress ? "Results appear when the check finishes." : s.coverageNote}</p>
      <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs text-muted sm:grid-cols-2">
        <div>
          <dt className="inline font-medium text-ink">Next check: </dt>
          <dd className="inline" data-testid={`due-${s.id}`}>
            {s.dueWhen ? (
              <>
                {s.freshnessLabel} · {s.dueWhen} <span className="whitespace-nowrap">({s.dueExact})</span>
              </>
            ) : (
              "Not scheduled yet"
            )}
          </dd>
        </div>
        <div>
          <dt className="inline font-medium text-ink">Last independent check: </dt>
          <dd className="inline">
            {s.lastIndependentAt ? `${formatDateTime(s.lastIndependentAt, TZ)}` : "None yet"}
          </dd>
        </div>
      </dl>
    </li>
  );
}

function AttemptHistoryRow({ row: h, objective, onChanged }: { row: Extract<HistoryRow, { kind: "attempt" }>; objective: string; onChanged: () => void }) {
  return (
    <li className={`border-b border-line px-4 py-3 last:border-b-0 ${h.excluded ? "bg-paper/60" : ""}`}>
      <details>
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-xs text-muted">{formatDateTime(h.at, TZ)}</span>
          <span className="text-sm font-medium">{h.stage}</span>
          <span className="text-sm text-muted">{objective}</span>
          <Pill tone={h.evidenceKind === "independent" ? "good" : h.evidenceKind === "supported" ? "info" : "neutral"}>{h.resultLabel}</Pill>
          {h.isTransfer && <Pill>New-context question</Pill>}
          <span className="text-xs text-teal underline underline-offset-2">Details</span>
        </summary>
        <div className="mt-3 space-y-3 rounded-lg bg-paper p-3">
          <div>
            <p className="text-xs font-medium text-muted">Your answer ({h.questionId})</p>
            <p className="mt-1 whitespace-pre-wrap text-sm">{h.answer}</p>
          </div>
          {h.feedback ? (
            <CriterionFeedback feedback={{ ...h.feedback, excluded: h.excluded, excludedReason: h.excludedReason }} />
          ) : (
            <p className="text-xs text-muted">
              {h.evidenceKind === "pending" ? "Feedback appears once the assessment is complete and released." : "Feedback for this answer was not released."}
              {h.providerLabel ? ` ${h.providerLabel}.` : ""}
            </p>
          )}
          {h.excluded && !h.feedback && (
            <p className="text-xs text-amber-ink">This judgement is excluded from your learning record ({h.excludedReason}).</p>
          )}
          {h.assessmentId && !h.excluded && <FlagJudgementButton assessmentId={h.assessmentId} onFlagged={onChanged} />}
        </div>
      </details>
    </li>
  );
}
