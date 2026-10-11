"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, ArrowUpRight, CalendarClock, RotateCw, SlidersHorizontal } from "lucide-react";
import type { ActionKind } from "@/lib/domain/plan";
import type { ProviderInfo } from "../ProviderBadge";
import { SessionDial } from "../SessionDial";
import { openImportDialog } from "../dataEvents";
import { LevelBar, rollupSentence } from "../levels";
import { useApiResource } from "../useApiResource";
import { ProviderNotice, readBudget, saveBudget, useContinue, type Budget, type CourseSummaryView, type StudyTaskView } from "../workspace";

interface ModuleStudy {
  id: string;
  inPlan: boolean;
  nextUp: { kind: ActionKind; kindLabel: string; subtopicTitles: string; reason: string; totalMinutes: number } | null;
  nextCheckWhen: string | null;
}

interface HomeData {
  provider: ProviderInfo;
  recommendation: StudyTaskView | null;
  plan: StudyTaskView[];
  totalMinutes: number;
  upToDate: boolean;
  nextScheduledCheck: { topicId: string; topicTitle: string; focus: string; dueAt: number; dueWhen: string | null } | null;
  courses: CourseSummaryView[];
  modules: ModuleStudy[];
  planSettings: { modules: "all" | "chosen"; moduleIds: string[] };
}

export function HomeScreen() {
  const [budget, setBudget] = useState<Budget>(readBudget);
  // The dial label follows the drag; the plan refetches once the value settles.
  const [dial, setDial] = useState<Budget>(budget);
  const { data, error, reload } = useApiResource<HomeData>(`/api/home?budget=${budget}`);
  const go = useContinue();

  function commitBudget(b: Budget) {
    setDial(b);
    setBudget(b);
    saveBudget(b);
  }

  if (error && !data) {
    return (
      <div role="alert" className="rounded-xl border border-red-ink/20 bg-red-soft p-5 text-red-ink">
        <p className="font-medium">We couldn&apos;t load your study plan.</p>
        <p className="mt-1 text-sm">{error}</p>
        <button
          type="button"
          onClick={reload}
          className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-[7px] border border-red-ink/30 bg-card px-3.5 text-sm font-medium"
        >
          <RotateCw size={15} aria-hidden="true" /> Retry
        </button>
      </div>
    );
  }
  if (!data) return <HomeSkeleton />;

  const approved = data.courses.filter((c) => c.status === "approved");
  return (
    // One viewport on large screens: the session on the left, modules on the right; each side scrolls internally if needed.
    <div className="grid gap-5 lg:h-[calc(100dvh-121px)] lg:min-h-[520px] lg:grid-cols-[minmax(0,1.25fr)_minmax(320px,1fr)]">
      <h1 className="sr-only">Overview</h1>
      {/* Mode lives in the sidebar footer; only a broken live configuration earns space here. */}
      {data.provider.mode === "live" && !data.provider.ready && (
        <div className="lg:col-span-2">
          <ProviderNotice provider={data.provider} />
        </div>
      )}
      {go.error && (
        <p role="alert" className="rounded-lg border border-red-ink/20 bg-red-soft px-4 py-3 text-sm text-red-ink lg:col-span-2">
          {go.error}
        </p>
      )}
      {data.courses.length === 0 ? (
        <FirstLecture />
      ) : (
        <SessionCard
          data={data}
          dial={dial}
          onDial={setDial}
          onCommit={commitBudget}
          onContinue={() => go.start({ budgetMinutes: budget })}
          busy={go.busy}
          approvedCount={approved.length}
        />
      )}
      <ModulesPanel data={data} budget={budget} />
    </div>
  );
}

// ---------------------------------------------------------------- session card

const VERB: Record<ActionKind, string> = {
  resume: "Finish",
  learn: "Start",
  practice: "Practise",
  check: "Check",
  review: "Review",
  view: "Open",
};

/** "Finish Model notation, then start Dataset likelihood." or, with more steps, "Review Log objective, then 2 more steps." */
function sessionSentence(tasks: StudyTaskView[]): string {
  const phrase = (t: StudyTaskView) => `${t.kind === "learn" && t.reason !== "Not studied yet" ? "Continue" : VERB[t.kind]} ${t.subtopicTitles.replace(/ · /g, " & ")}`;
  const lower = (x: string) => x.charAt(0).toLowerCase() + x.slice(1);
  const [a, b] = tasks;
  if (!a) return "";
  if (tasks.length === 1) return `${phrase(a)}.`;
  if (tasks.length === 2) return `${phrase(a)}, then ${lower(phrase(b))}.`;
  return `${phrase(a)}, then ${tasks.length - 1} more steps.`;
}

const DOT: Record<ActionKind, string> = {
  resume: "bg-ink",
  learn: "bg-lv2",
  practice: "bg-lv2",
  check: "bg-lv3",
  review: "bg-due",
  view: "bg-line-strong",
};

function SessionCard({
  data,
  dial,
  onDial,
  onCommit,
  onContinue,
  busy,
  approvedCount,
}: {
  data: HomeData;
  dial: Budget;
  onDial: (m: Budget) => void;
  onCommit: (m: Budget) => void;
  onContinue: () => void;
  busy: boolean;
  approvedCount: number;
}) {
  const tasks = data.plan;
  const resuming = tasks[0]?.action === "resume";
  const chosen = data.planSettings.modules === "chosen";
  const scopeText = chosen
    ? `Planning from ${data.planSettings.moduleIds.length} of ${approvedCount} module${approvedCount === 1 ? "" : "s"}`
    : approvedCount > 1
      ? `Planning across all ${approvedCount} modules`
      : "Planning from your module";

  return (
    <section
      aria-labelledby="session-title"
      data-testid="recommendation"
      className="flex min-h-0 flex-col rounded-2xl border border-line bg-card p-5 shadow-[0_3px_15px_rgba(33,59,41,0.06)] sm:p-7"
    >
      <p className="text-[13px] font-medium text-teal">{tasks.length === 0 ? "Today" : resuming ? "Pick up where you left off" : "Today's session"}</p>

      {tasks.length === 0 ? (
        <UpToDate data={data} />
      ) : (
        <>
          <div className="mt-2 flex flex-col-reverse gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h2 id="session-title" className="text-[22px] font-semibold leading-snug tracking-tight sm:text-[25px]" data-testid="session-sentence">
                {sessionSentence(tasks)}
              </h2>
              <p className="mt-2 text-sm text-muted">
                {tasks.length} step{tasks.length === 1 ? "" : "s"} · about {data.totalMinutes} minutes. Turn the dial to plan more or less.
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-center gap-1 self-center sm:self-start">
              <SessionDial value={dial} onChange={onDial} onCommit={onCommit} />
            </div>
          </div>

          <ol className="mt-4 min-h-0 flex-1 overflow-y-auto border-t border-line" aria-label="Steps in this session">
            {tasks.map((t, i) => (
              <li key={t.id} data-testid="plan-row" className="flex items-start gap-3 border-b border-line py-3 last:border-b-0">
                <span className="mt-[7px] flex w-4 shrink-0 justify-center" aria-hidden="true">
                  <span className={`size-2 rounded-full ${DOT[t.kind]}`} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    <span className="sr-only">Step {i + 1}: </span>
                    {t.subtopicTitles}
                  </p>
                  <p className="text-xs text-muted">
                    {t.kindLabel} · {t.topicTitle} · {t.reason}
                  </p>
                </div>
                <span className="shrink-0 pt-0.5 text-xs text-muted">{t.estimatedMinutes} min</span>
              </li>
            ))}
          </ol>

          <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <Link href="/settings" className="inline-flex min-h-10 items-center gap-1.5 text-xs text-muted hover:text-teal" data-testid="plan-scope">
              <SlidersHorizontal size={14} aria-hidden="true" />
              {scopeText}
            </Link>
            <button
              type="button"
              onClick={onContinue}
              disabled={busy}
              data-testid="continue"
              className="inline-flex min-h-12 items-center gap-2 rounded-lg bg-teal px-6 text-[15px] font-medium text-white transition-colors hover:bg-teal-dark disabled:opacity-60 motion-reduce:transition-none"
            >
              {busy ? "Starting…" : `Continue · ${data.totalMinutes} min`}
              <ArrowRight size={17} aria-hidden="true" />
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function UpToDate({ data }: { data: HomeData }) {
  const rec = data.recommendation;
  if (rec?.action === "view" && !data.nextScheduledCheck) {
    return (
      <div className="flex flex-1 flex-col justify-center">
        <h2 id="session-title" className="mt-2 text-[28px] font-semibold tracking-tight">
          Reviewed questions needed
        </h2>
        <p className="mt-2 max-w-[520px] text-[15px] text-muted">{rec.reason}.</p>
      </div>
    );
  }
  return (
    <div className="flex flex-1 flex-col justify-center">
      <h2 id="session-title" className="mt-2 text-[28px] font-semibold tracking-tight">
        You&apos;re done for now
      </h2>
      <p className="mt-2 flex max-w-[520px] items-start gap-2 text-[15px] text-muted" data-testid="upcoming-check">
        <CalendarClock size={17} aria-hidden="true" className="mt-0.5 shrink-0" />
        {data.nextScheduledCheck ? (
          <span>
            Next up: a check without help on {data.nextScheduledCheck.focus} ({data.nextScheduledCheck.topicTitle}),{" "}
            <span className="font-medium text-ink">{data.nextScheduledCheck.dueWhen}</span>.
          </span>
        ) : (
          <span>Nothing is due and nothing new is waiting.</span>
        )}
      </p>
      <p className="mt-4 text-sm text-muted">Want to keep going? Use Study now on any module.</p>
    </div>
  );
}

function FirstLecture() {
  return (
    <section className="flex flex-col justify-center rounded-2xl border border-line bg-card p-7 shadow-[0_3px_15px_rgba(33,59,41,0.06)]" data-testid="recommendation">
      <p className="text-[13px] font-medium text-teal">Get started</p>
      <h2 className="mt-2 text-[28px] font-semibold tracking-tight">Add your first lecture</h2>
      <p className="mt-2 max-w-[480px] text-[15px] text-muted">
        Import a text-based lecture PDF. Proximal drafts its topics and subtopics for you to approve, then plans every session from there.
      </p>
      <button
        type="button"
        onClick={openImportDialog}
        className="mt-5 inline-flex min-h-11 w-fit items-center rounded-lg bg-teal px-5 text-sm font-medium text-white hover:bg-teal-dark"
      >
        Import lecture
      </button>
    </section>
  );
}

// ---------------------------------------------------------------- modules

function ModulesPanel({ data, budget }: { data: HomeData; budget: Budget }) {
  const study = new Map(data.modules.map((m) => [m.id, m]));
  const drafts = data.courses.filter((c) => c.status === "draft");
  const approved = data.courses.filter((c) => c.status === "approved");
  return (
    <section aria-labelledby="modules-title" className="flex min-h-0 flex-col">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="modules-title" className="text-[17px] font-semibold tracking-tight">
          Your modules
        </h2>
        <Link href="/courses" className="text-xs text-muted hover:text-teal">
          All modules
        </Link>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-1">
        {drafts.map((c) => (
          <DraftRow key={c.id} module={c} />
        ))}
        {approved.map((c) => (
          <ModuleRow key={c.id} module={c} study={study.get(c.id)} budget={budget} />
        ))}
        {data.courses.length === 0 && (
          <p className="rounded-xl border border-dashed border-line-strong p-5 text-sm text-muted">
            Modules appear here once you import and approve a lecture.
          </p>
        )}
      </div>
    </section>
  );
}

function ModuleRow({ module: m, study, budget }: { module: CourseSummaryView; study?: ModuleStudy; budget: Budget }) {
  const go = useContinue();
  const next = study?.nextUp;
  return (
    <article aria-labelledby={`module-${m.id}`} data-testid={`course-${m.id}`} className="rounded-xl border border-line bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/courses/${m.id}`} id={`module-${m.id}`} className="font-semibold hover:text-teal hover:underline">
            {m.title}
          </Link>
          <p className="text-xs text-muted">
            {m.mastery.checked} of {m.mastery.total} subtopics checked on your own
            {m.mastery.due > 0 && <span className="text-amber-ink"> · {m.mastery.due} due</span>}
          </p>
        </div>
        {study && !study.inPlan && <span className="shrink-0 rounded-md bg-paper px-2 py-0.5 text-[11px] text-muted">Not in your plan</span>}
      </div>
      <div className="mt-3">
        <LevelBar subtopics={m.subtopicLevels} label={rollupSentence(m.mastery)} />
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-xs text-muted">
          {next ? (
            <>
              Next: <span className="text-ink">{next.kindLabel}</span> · {next.subtopicTitles}
            </>
          ) : study?.nextCheckWhen ? (
            <>Up to date · next check {study.nextCheckWhen}</>
          ) : (
            "Up to date"
          )}
        </p>
        <button
          type="button"
          onClick={() => go.start({ courseId: m.id, budgetMinutes: budget })}
          disabled={!next || go.busy}
          data-testid={`study-now-${m.id}`}
          className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-[7px] border border-line-strong bg-card px-3 text-sm font-medium transition-colors hover:border-teal hover:text-teal disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
        >
          {go.busy ? "Starting…" : "Study now"}
        </button>
      </div>
      {go.error && <p className="mt-2 text-xs text-red-ink">{go.error}</p>}
    </article>
  );
}

function DraftRow({ module: m }: { module: CourseSummaryView }) {
  return (
    <article data-testid={`course-${m.id}`} className="rounded-xl border border-amber-ink/25 bg-amber-soft p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-amber-ink">Needs your review</p>
      <p className="mt-1 font-semibold">{m.title}</p>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-amber-ink">
          {m.topicCount} topics · {m.mastery.total} subtopics drafted{m.sourceLabel ? ` from ${m.sourceLabel}` : ""}
        </p>
        <Link href={`/courses/${m.id}`} className="inline-flex min-h-9 items-center gap-1 text-sm font-medium text-teal hover:underline">
          Review draft <ArrowUpRight size={15} aria-hidden="true" />
        </Link>
      </div>
    </article>
  );
}

function HomeSkeleton() {
  return (
    <div aria-busy="true" className="grid gap-5 lg:h-[calc(100dvh-121px)] lg:grid-cols-[minmax(0,1.25fr)_minmax(320px,1fr)]">
      <div className="h-[420px] rounded-2xl border border-line bg-card lg:h-auto" />
      <div className="h-[240px] rounded-xl border border-line bg-card" />
      <span className="sr-only" role="status">
        Loading your study plan…
      </span>
    </div>
  );
}
