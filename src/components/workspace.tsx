"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  CalendarClock,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  Clock3,
  Info,
  Layers,
  Sparkles,
} from "lucide-react";
import { lowerFirst, type ActionKind } from "@/lib/domain/plan";
import { vendorName } from "@/lib/domain/labels";
import type { EvidenceState } from "@/lib/domain/types";
import { api, ApiError } from "./api";
import { EvidenceLabel } from "./EvidenceLabel";
import { ProviderBadge, type ProviderInfo } from "./ProviderBadge";

export interface StudyTaskView {
  id: string;
  courseId: string;
  topicId: string;
  topicTitle: string;
  skillIds: string[];
  objectives: string[];
  focus: string;
  summary: string;
  action: ActionKind;
  title: string;
  reason: string;
  estimatedMinutes: number;
  dueAt: number | null;
  dueWhen: string | null;
  dueExact: string | null;
  sessionId: string | null;
}

export interface CourseSummaryView {
  id: string;
  title: string;
  isDemo: boolean;
  status: "draft" | "approved";
  topicCount: number;
  requiredSkillCount: number;
  independentlyCheckedSkillCount: number;
  sourceLabel: string | null;
  firstTopicId: string | null;
}

export const ACTION_LABEL: Record<ActionKind, string> = {
  learn: "Learn",
  practice: "Practise",
  check: "Check",
  review: "Review",
  resume: "Resume",
  view: "View",
};

const CTA: Record<ActionKind, string> = {
  learn: "Start learning",
  practice: "Start practice",
  check: "Start check",
  review: "Start review",
  resume: "Resume session",
  view: "View topic",
};

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Launch a task: resume/view navigate; learn/practice/check/review start (or resume) a persisted session. */
export function useStartTask() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function start(task: StudyTaskView) {
    setError(null);
    if (task.action === "resume" && task.sessionId) return router.push(`/sessions/${task.sessionId}`);
    if (task.action === "view") return router.push(`/topics/${task.topicId}`);
    setBusy(task.id);
    try {
      const res = await api<{ sessionId: string }>("/api/sessions", {
        method: "POST",
        json: { topicId: task.topicId, purpose: task.action, skillIds: task.skillIds },
      });
      router.push(`/sessions/${res.sessionId}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start this task.");
      setBusy(null);
    }
  }
  return { start, busy, error };
}

/** Restrained provider status with expandable details; a broken live configuration stays a prominent alert. */
export function ProviderNotice({ provider }: { provider: ProviderInfo }) {
  const [open, setOpen] = useState(false);
  if (provider.mode === "live" && !provider.ready) return <ProviderBadge provider={provider} />;
  const mock = provider.mode === "mock";
  return (
    <div data-testid="provider-badge">
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <Info size={15} aria-hidden="true" />
        <span>{mock ? "Offline demo · supplied examples only." : `${vendorName(provider.vendor)} assessment.`}</span>
        <button
          type="button"
          aria-expanded={open}
          aria-controls="provider-detail"
          onClick={() => setOpen((o) => !o)}
          className="text-teal underline underline-offset-[3px]"
        >
          Details
        </button>
      </p>
      <div id="provider-detail" hidden={!open} className="mt-2.5 rounded-[7px] bg-amber-soft px-4 py-3 text-xs text-amber-ink">
        {mock ? (
          "Only the supplied example answers can be assessed in this mode. Other answers are marked uncertain."
        ) : (
          <>
            <p>
              Judgements are checked against frozen rubrics on the server, can be uncertain and can be flagged. A live failure never
              falls back to the offline demo.
            </p>
            {provider.models && (
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5" data-testid="provider-models">
                <dt className="font-medium">Assessment</dt>
                <dd>{provider.models.assess}</dd>
                <dt className="font-medium">Curriculum</dt>
                <dd>{provider.models.curriculum}</dd>
                <dt className="font-medium">Tutor</dt>
                <dd>{provider.models.tutor}</dd>
              </dl>
            )}
            {provider.keySource && (
              <p className="mt-2">
                API key from {provider.keySource === ".env" ? "the project .env file" : "the shell environment"}.
                {provider.shellKeyIgnored && " A different key exported in your shell is ignored."}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function TimeBudgetControl({ value, onChange }: { value: number; onChange: (v: 10 | 20 | 30) => void }) {
  return (
    <div role="group" aria-label="Study time" className="flex gap-0.5 rounded-lg border border-line-strong bg-card p-[3px]">
      {([10, 20, 30] as const).map((b) => (
        <button
          key={b}
          type="button"
          aria-pressed={value === b}
          onClick={() => onChange(b)}
          className={`min-h-9 rounded-[5px] px-3 text-xs transition-colors motion-reduce:transition-none ${
            value === b ? "bg-teal-soft font-medium text-teal" : "text-muted hover:text-ink"
          }`}
        >
          {b} min
        </button>
      ))}
    </div>
  );
}

export function RecommendationCard({
  task,
  courseTitle,
  onStart,
  busy,
}: {
  task: StudyTaskView;
  courseTitle: string | null;
  onStart: () => void;
  busy: boolean;
}) {
  const isView = task.action === "view";
  return (
    <article
      aria-labelledby="rec-title"
      data-testid="recommendation"
      className="mb-6 rounded-xl border border-line bg-card p-5 shadow-[0_3px_15px_rgba(33,59,41,0.06)] sm:p-6"
    >
      <p className="inline-flex items-center gap-1.5 text-[13px] font-medium text-teal">
        <Sparkles size={15} aria-hidden="true" />
        {task.title}
      </p>
      <h3 id="rec-title" className="mb-2 mt-2.5 text-[24px] font-semibold leading-tight tracking-tight sm:text-[27px]">
        {task.topicTitle}
      </h3>
      {task.summary && <p className="max-w-[560px] text-[15px] text-muted">{task.summary}</p>}
      <div className="my-5 flex flex-wrap items-center gap-4 text-xs text-muted">
        {task.estimatedMinutes > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <Clock3 size={14} aria-hidden="true" />
            About {task.estimatedMinutes} minutes
          </span>
        )}
        {task.skillIds.length > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <Layers size={14} aria-hidden="true" />
            {plural(task.skillIds.length, "skill")}
          </span>
        )}
        {courseTitle && <span>{courseTitle}</span>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <span className="text-sm text-muted">
          {isView && task.dueWhen ? (
            <>
              Next check <span className="font-medium text-ink">{task.dueWhen}</span>
              <span className="text-xs"> ({task.dueExact})</span>
            </>
          ) : (
            task.reason
          )}
        </span>
        <button
          type="button"
          onClick={onStart}
          disabled={busy}
          data-testid="recommendation-cta"
          className="inline-flex min-h-11 items-center gap-2 rounded-[7px] border border-teal bg-teal px-4 text-sm font-medium text-white transition-colors hover:bg-teal-dark disabled:opacity-60 motion-reduce:transition-none"
        >
          {busy ? "Starting…" : CTA[task.action]}
          <ArrowRight size={16} aria-hidden="true" />
        </button>
      </div>
    </article>
  );
}

export function StudyTaskList({
  tasks,
  totalMinutes,
  onStart,
  busy,
}: {
  tasks: StudyTaskView[];
  totalMinutes: number;
  onStart: (t: StudyTaskView) => void;
  busy: string | null;
}) {
  const summary =
    tasks.length === 1 ? `One task available · about ${totalMinutes} minutes` : `${tasks.length} tasks · about ${totalMinutes} minutes`;
  return (
    <section aria-labelledby="plan-title" className="mb-8">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 id="plan-title" className="text-[17px] font-semibold tracking-tight">
          Your session plan
        </h2>
        <span className="text-xs text-muted" aria-live="polite" data-testid="plan-summary">
          {summary}
        </span>
      </div>
      <ol className="overflow-hidden rounded-[10px] border border-line bg-card">
        {tasks.map((t, i) => (
          <li
            key={t.id}
            data-testid="plan-row"
            className="grid grid-cols-[26px_minmax(0,1fr)] items-center gap-x-3 gap-y-2 border-b border-line px-4 py-3.5 last:border-b-0 sm:grid-cols-[28px_minmax(0,1fr)_auto] sm:px-[18px]"
          >
            <span aria-hidden="true" className="grid size-[26px] place-items-center rounded-[7px] bg-paper text-xs text-muted">
              {i + 1}
            </span>
            <div className="min-w-0">
              <p className="mb-0.5 font-medium">
                <span className="mr-2 rounded-[5px] bg-teal-soft px-1.5 py-0.5 text-[11px] font-medium text-teal">{ACTION_LABEL[t.action]}</span>
                {t.topicTitle}
              </p>
              <p className="text-xs text-muted">
                {t.focus ? `${t.focus} · ${lowerFirst(t.reason)}` : t.reason}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onStart(t)}
              disabled={busy !== null}
              aria-label={`${ACTION_LABEL[t.action]}: ${t.topicTitle}, about ${t.estimatedMinutes} minutes`}
              className="col-start-2 flex min-h-11 items-center gap-1 justify-self-start text-sm text-muted hover:text-teal sm:col-start-auto sm:justify-self-end"
            >
              <span>{busy === t.id ? "Starting…" : `${t.estimatedMinutes} min`}</span>
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

export interface RecentEvidenceView {
  topicId: string;
  topicTitle: string;
  skillId: string;
  objective: string;
  skillLabel: string;
  summary: string;
  taskNoun: string;
  evidenceState: EvidenceState;
  freshnessLabel: string | null;
  dueWhen: string | null;
}

export function RecentEvidence({ rows }: { rows: RecentEvidenceView[] }) {
  return (
    <section aria-labelledby="recent-title" className="mb-8">
      <h2 id="recent-title" className="mb-3 text-[17px] font-semibold tracking-tight">
        Recent evidence
      </h2>
      <ul className="overflow-hidden rounded-[10px] border border-line bg-card">
        {rows.map((r) => (
          <li
            key={r.skillId}
            data-testid={`recent-${r.skillId}`}
            className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 last:border-b-0 sm:px-[18px]"
          >
            <div className="min-w-0">
              <p className="text-sm">
                <span className="font-medium">{capitalise(r.taskNoun)}</span>
                <span className="text-muted"> · {r.topicTitle}</span>
              </p>
              <p className="text-xs text-muted">
                {r.summary}
                {r.dueWhen ? ` · next check ${r.dueWhen}` : ""}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <EvidenceLabel state={r.evidenceState} />
              <Link href={`/topics/${r.topicId}`} className="inline-flex min-h-10 items-center text-sm font-medium text-teal hover:underline">
                Open topic
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function UpcomingCheck({
  check,
}: {
  check: { topicId: string; topicTitle: string; noun: string; focus: string; dueWhen: string | null; dueExact: string | null };
}) {
  return (
    <section aria-labelledby="upcoming-title" className="mb-8">
      <h2 id="upcoming-title" className="mb-3 text-[17px] font-semibold tracking-tight">
        Upcoming check
      </h2>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-line bg-card px-4 py-3.5 sm:px-[18px]" data-testid="upcoming-check">
        <div className="flex min-w-0 items-start gap-3">
          <CalendarClock size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-teal" />
          <div className="min-w-0">
            <p className="text-sm">
              <span className="font-medium">Fresh {check.noun === "topic" ? "" : `${check.noun} `}check</span>
              <span className="text-muted"> · {check.topicTitle}</span>
            </p>
            <p className="text-xs text-muted">
              Scheduled <span className="font-medium text-teal">{check.dueWhen}</span> ({check.dueExact}) · {check.focus} · a new question will be used
            </p>
          </div>
        </div>
        <Link href={`/topics/${check.topicId}`} className="inline-flex min-h-10 items-center text-sm font-medium text-teal hover:underline">
          View topic
        </Link>
      </div>
    </section>
  );
}

export function CourseList({ courses, headingLevel = "h2" }: { courses: CourseSummaryView[]; headingLevel?: "h1" | "h2" }) {
  const Heading = headingLevel;
  return (
    <section aria-labelledby="courses-title" id="courses">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <Heading
          id="courses-title"
          className={headingLevel === "h1" ? "text-[28px] font-semibold leading-tight tracking-tight sm:text-[30px]" : "text-[17px] font-semibold tracking-tight"}
        >
          Your courses
        </Heading>
        <span className="text-xs text-muted">{plural(courses.length, "course")}</span>
      </div>
      {courses.length === 0 ? (
        <p className="rounded-[10px] border border-line bg-card p-5 text-sm text-muted">
          No courses yet. Use Import lecture above, or run <code>npm run db:seed</code> for the sample course.
        </p>
      ) : (
        <div className="space-y-3">
          {courses.map((c) => (
            <CourseCard key={c.id} course={c} />
          ))}
        </div>
      )}
    </section>
  );
}

function CourseCard({ course }: { course: CourseSummaryView }) {
  const draft = course.status === "draft";
  const details = [plural(course.topicCount, "topic"), plural(course.requiredSkillCount, "required skill"), course.sourceLabel]
    .filter(Boolean)
    .join(" · ");
  const EvidenceIcon = course.independentlyCheckedSkillCount > 0 ? CircleCheck : CircleDashed;
  return (
    <article
      aria-labelledby={`course-${course.id}`}
      data-testid={`course-${course.id}`}
      className="grid grid-cols-[36px_minmax(0,1fr)] items-center gap-3 rounded-[10px] border border-line bg-card p-5 sm:grid-cols-[42px_minmax(0,1fr)_auto] sm:gap-4"
    >
      <span aria-hidden="true" className="grid h-[46px] w-9 place-items-center rounded-lg bg-teal-soft text-teal sm:w-[42px]">
        <BookOpen size={20} />
      </span>
      <div className="min-w-0">
        <h3 id={`course-${course.id}`} className="mb-1 text-[15px] font-semibold">
          {course.title}
        </h3>
        <p className="text-xs text-muted">{details}</p>
      </div>
      <Link
        href={`/courses/${course.id}`}
        className="col-start-2 inline-flex min-h-10 items-center gap-1.5 justify-self-start text-sm font-medium text-teal hover:underline sm:col-start-auto sm:justify-self-auto"
      >
        {draft ? "Review draft" : "Open course"}
        <ArrowUpRight size={16} aria-hidden="true" />
      </Link>
      <p className="col-span-full flex flex-wrap items-center gap-2 border-t border-line pt-3.5 text-xs text-muted sm:col-start-2">
        <EvidenceIcon size={15} aria-hidden="true" />
        {draft
          ? "Objectives need your approval before study"
          : `${course.independentlyCheckedSkillCount} of ${plural(course.requiredSkillCount, "required skill")} checked independently`}
        <span className="whitespace-nowrap rounded-[5px] bg-paper px-2 py-0.5 text-[11px]">
          {course.isDemo ? "Demo content" : draft ? "Draft" : "Imported"}
        </span>
      </p>
    </article>
  );
}
