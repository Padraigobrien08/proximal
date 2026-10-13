"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowRight, ChevronDown, CircleHelp, FileText } from "lucide-react";
import type { Level, LevelRollup } from "@/lib/domain/levels";
import { formatDateTime } from "@/lib/domain/labels";
import type { EvidenceState } from "@/lib/domain/types";
import { api, ApiError } from "../api";
import { CriterionFeedback, type FeedbackData } from "../CriterionFeedback";
import { EvidenceLabel } from "../EvidenceLabel";
import { FlagJudgementButton } from "../FlagDialog";
import { HistoricalReplay } from "../HistoricalReplay";
import type { ProviderInfo } from "../ProviderBadge";
import { useApiResource } from "../useApiResource";
import { AskButton } from "../AskButton";
import { DuePill, HowLevelsWork, LevelLadder, LevelPill, RollupSummary } from "../levels";
import { ProviderNotice, useContinue } from "../workspace";
import { Notice, Pill } from "../ui";
import { LearningApproachPanel, type ApproachSummary } from "../LearningApproach";
import { QuestionDraftsPanel } from "../QuestionDrafts";
import { MaterialDraftsPanel } from "../MaterialDrafts";

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
  | { kind: "help"; at: number; id: string; label: string; skillIds: string[] }
  | { kind: "activity"; at: number; id: string; skillId: string; label: string; typeLabel: string; text: string };

interface TopicData {
  provider: ProviderInfo;
  topic: { id: string; title: string };
  course: { id: string; title: string; isDemo: boolean; status: string };
  source: { id: string; label: string } | null;
  units: { id: string; title: string; objective: string; sourcePages: number[] }[];
  rollup: LevelRollup;
  subtopics: {
    id: string;
    title: string;
    objective: string;
    sourcePages: number[];
    level: Level;
    due: boolean;
    skillIds: string[];
    lastLabel: string | null;
    nextLabel: string;
  }[];
  skills: SkillRow[];
  reviewAvailable: boolean;
  learnAvailable: boolean;
  primaryAction: "learn" | "check" | "review";
  activeSessions: { id: string; mode: string; purpose: string; phase: string; startedAt: string }[];
  history: HistoryRow[];
  learningApproach: { available: boolean; skills: ApproachSummary[] };
}

const PURPOSE_TEXT: Record<string, string> = {
  learn: "learning session",
  practice: "practice",
  check: "quick check",
  review: "review",
};

export function TopicScreen({ topicId }: { topicId: string }) {
  const router = useRouter();
  const { data, error, reload } = useApiResource<TopicData>(`/api/topics/${topicId}`);
  const [starting, setStarting] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const go = useContinue();

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
  const anyFixture = data.skills.some((s) => s.questionStatuses.includes("authored_fixture"));
  const dueSkills = data.skills.filter((s) => s.isDue && s.reviewAvailable);

  const choices = [
    {
      key: "learn" as const,
      testId: "start-learn",
      label: "Learn from the start",
      hint: "Explanations first, help available. Counts as practice.",
      disabled: !data.learnAvailable,
      reason: "No practice questions or tutor are available for this topic in offline mode.",
    },
    {
      key: "check" as const,
      testId: "start-review",
      label: "Check myself now",
      hint: "No help. Feedback once every answer is saved. Can move subtopics to Checked.",
      disabled: !data.reviewAvailable,
      reason: "Reviewed assessment questions needed.",
    },
    ...(dueSkills.length > 0
      ? [
          {
            key: "review" as const,
            testId: "start-due-review",
            label: "Review what's due",
            hint: `A no-help review of ${dueSkills.length === 1 ? "one skill" : `${dueSkills.length} skills`} that ${dueSkills.length === 1 ? "is" : "are"} due.`,
            disabled: false,
            reason: "",
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/courses/${data.course.id}`} className="text-sm text-teal hover:underline">
          ← {data.course.title}
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-[28px] font-semibold leading-tight tracking-tight sm:text-[30px]">{data.topic.title}</h1>
            <p className="mt-1 text-[15px] text-muted">
              {data.rollup.total} subtopic{data.rollup.total === 1 ? "" : "s"} · {data.rollup.checked} checked on your own
              {data.source && (
                <>
                  {" "}
                  · {data.source.label}, PDF page{pages.length === 1 ? "" : "s"} {pages.join(", ")}
                </>
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <AskButton courseId={data.course.id} />
            <div className="relative">
              <button
                type="button"
                onClick={() => setMenuOpen((o) => !o)}
                aria-expanded={menuOpen}
                aria-controls="study-choices"
                data-testid="choose-study"
                className="inline-flex min-h-11 items-center gap-2 rounded-[7px] border border-line-strong bg-card px-4 text-sm font-medium hover:border-teal hover:text-teal"
              >
                Choose what to study
                <ChevronDown size={15} aria-hidden="true" className={menuOpen ? "rotate-180" : ""} />
              </button>
              <div
                id="study-choices"
                hidden={!menuOpen}
                className="absolute right-0 top-[calc(100%+6px)] z-10 w-[min(320px,calc(100vw-2rem))] rounded-[10px] border border-line bg-card p-1.5 shadow-lg"
              >
                {choices.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => start(c.key)}
                    disabled={c.disabled || starting !== null}
                    data-testid={c.testId}
                    className="block w-full rounded-[7px] px-3 py-2.5 text-left text-sm hover:bg-teal-soft disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className="font-medium">{starting === c.key ? "Starting…" : c.label}</span>
                    <span className="mt-0.5 block text-xs text-muted">{c.disabled ? c.reason : c.hint}</span>
                  </button>
                ))}
              </div>
            </div>
            <button
              type="button"
              onClick={() => go.start({ topicId })}
              disabled={go.busy || (!data.learnAvailable && !data.reviewAvailable)}
              data-testid="continue-topic"
              className="inline-flex min-h-11 items-center gap-2 rounded-[7px] bg-teal px-4 text-sm font-medium text-white hover:bg-teal-dark disabled:opacity-60"
            >
              {go.busy ? "Starting…" : "Continue"}
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
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
      {(actionError || go.error) && <Notice tone={go.error ? "warn" : "error"}>{actionError ?? go.error}</Notice>}
      {!data.reviewAvailable && (
        <Notice tone="warn">
          {data.course.isDemo ? (
            "No-help checks need reviewed assessment questions."
          ) : (
            <>
              No-help checks need an approved question. Draft and approve questions under <strong>Check questions</strong> below,
              or attach a bank with <code className="mx-1">npm run questions:import</code>. Imported objectives are never mapped to
              demo questions.
            </>
          )}
        </Notice>
      )}

      <section className="rounded-xl border border-line bg-card p-5 sm:p-6" data-testid="topic-summary">
        <RollupSummary rollup={data.rollup} subtopics={data.subtopics} />
      </section>

      <section aria-labelledby="subtopics-title">
        <h2 id="subtopics-title" className="mb-3 text-[17px] font-semibold tracking-tight">
          Subtopics
        </h2>
        <ul className="overflow-hidden rounded-xl border border-line bg-card">
          {data.subtopics.map((u) => (
            <li key={u.id} className="border-b border-line px-5 py-4 last:border-b-0" data-testid={`subtopic-${u.id}`}>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                <div className="min-w-0">
                  <p className="font-semibold">{u.title}</p>
                  <p className="text-sm text-muted">{u.objective}</p>
                  <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                    {u.sourcePages.length > 0 && <span>PDF page {u.sourcePages.join(", ")}</span>}
                    {u.lastLabel && <span>{u.lastLabel}</span>}
                    <span className="font-medium text-ink">{u.nextLabel}</span>
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:flex-col sm:items-end">
                  {u.due && <DuePill />}
                  <LevelPill level={u.level} />
                  <LevelLadder level={u.level} />
                </div>
              </div>
              <details className="mt-2">
                <summary className="inline-flex min-h-8 items-center text-xs text-teal underline underline-offset-2">
                  Skill detail
                </summary>
                <ul className="mt-2 space-y-2">
                  {u.skillIds
                    .map((id) => skillById.get(id))
                    .filter((s): s is SkillRow => !!s)
                    .map((s) => (
                      <SkillEvidenceRow key={s.id} skill={s} />
                    ))}
                </ul>
              </details>
            </li>
          ))}
        </ul>
        <p className="mt-3 flex items-start gap-2 text-xs text-muted">
          <CircleHelp size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
          The app can&apos;t see other tabs or notes, so a no-help check relies on you to declare outside help.
          {anyFixture &&
            (data.course.isDemo
              ? " Questions here are authored fixtures that the owner has not yet reviewed."
              : " Some questions here have not had their marking scheme reviewed by a person (see Check questions).")}
        </p>
      </section>

      {!data.course.isDemo && data.course.status === "approved" && (
        <QuestionDraftsPanel topicId={topicId} checkInProgress={data.activeSessions.some((s) => s.mode === "review")} onChanged={reload} />
      )}

      {data.learningApproach.available && data.learningApproach.skills.length > 0 && (
        <LearningApproachPanel
          topicId={topicId}
          skills={data.learningApproach.skills}
          checkInProgress={data.activeSessions.some((s) => s.mode === "review")}
          onChanged={reload}
        />
      )}

      {!data.course.isDemo && data.course.status === "approved" && <MaterialDraftsPanel topicId={topicId} onChanged={reload} />}

      <HowLevelsWork />

      <details className="rounded-xl border border-line bg-card px-5 py-4">
        <summary className="font-medium">Answer history</summary>
        <div className="mt-3">
          {data.history.length === 0 ? (
            <p className="text-sm text-muted">No answers recorded yet.</p>
          ) : (
            <ol className="overflow-hidden rounded-[10px] border border-line" data-testid="evidence-list">
              {data.history.map((h) =>
                h.kind === "activity" ? (
                  <li key={h.id} className="border-b border-line px-4 py-3 last:border-b-0" data-testid="activity-history">
                    <details>
                      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="text-xs text-muted">{formatDateTime(h.at, TZ)}</span>
                        <span className="text-sm font-medium">{h.label}</span>
                        <span className="text-sm text-muted">{skillById.get(h.skillId)?.objective ?? h.skillId}</span>
                        <Pill>Learning activity · not a check</Pill>
                        <span className="text-xs text-teal underline underline-offset-2">Details</span>
                      </summary>
                      <div className="mt-3 rounded-lg bg-paper p-3">
                        <p className="text-xs font-medium text-muted">Your response ({h.typeLabel})</p>
                        <p className="mt-1 whitespace-pre-wrap text-sm">{h.text}</p>
                        <p className="mt-2 text-xs text-muted">Saved as a learning response. It is not graded and does not change your level.</p>
                      </div>
                    </details>
                  </li>
                ) : h.kind === "help" ? (
                  <li key={h.id} className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5 text-xs text-muted last:border-b-0">
                    <FileText size={14} aria-hidden="true" />
                    <span>{formatDateTime(h.at, TZ)}</span>
                    <span className="font-medium text-amber-ink">{h.label}</span>
                    <span>· help recorded for {h.skillIds.map((id) => skillById.get(id)?.objective ?? id).join("; ")}</span>
                  </li>
                ) : (
                  <AttemptHistoryRow key={h.attemptId} row={h} objective={skillById.get(h.skillId)?.objective ?? h.skillId} onChanged={reload} />
                ),
              )}
            </ol>
          )}
        </div>
      </details>

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

function SkillEvidenceRow({ skill: s }: { skill: SkillRow }) {
  return (
    <li className="rounded-[10px] border border-line bg-paper/60 p-3" data-testid={`skill-${s.id}`}>
      <div className="flex flex-wrap items-center gap-2">
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
          <dt className="inline font-medium text-ink">Last no-help check: </dt>
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
