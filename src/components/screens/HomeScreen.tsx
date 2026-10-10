"use client";

import Link from "next/link";
import { useState } from "react";
import { RotateCw } from "lucide-react";
import type { ProviderInfo } from "../ProviderBadge";
import { openImportDialog } from "../dataEvents";
import { useApiResource } from "../useApiResource";
import {
  CourseList,
  ProviderNotice,
  RecentEvidence,
  RecommendationCard,
  StudyTaskList,
  TimeBudgetControl,
  UpcomingCheck,
  useStartTask,
  type CourseSummaryView,
  type RecentEvidenceView,
  type StudyTaskView,
} from "../workspace";

interface HomeData {
  provider: ProviderInfo;
  selectedBudgetMinutes: 10 | 20 | 30;
  recommendation: StudyTaskView | null;
  plan: StudyTaskView[];
  totalMinutes: number;
  upToDate: boolean;
  nextScheduledCheck: {
    topicId: string;
    topicTitle: string;
    skillIds: string[];
    objectives: string[];
    noun: string;
    focus: string;
    dueAt: number;
    dueWhen: string | null;
    dueExact: string | null;
  } | null;
  recentEvidence: RecentEvidenceView[];
  courses: CourseSummaryView[];
}

const BUDGET_KEY = "proximal.budget";

export function HomeScreen() {
  const [budget, setBudget] = useState<10 | 20 | 30>(() => {
    try {
      const saved = Number(localStorage.getItem(BUDGET_KEY));
      return saved === 10 || saved === 30 ? saved : 20;
    } catch {
      return 20;
    }
  });
  const { data, error, reload } = useApiResource<HomeData>(`/api/home?budget=${budget}`);
  const { start, busy, error: startError } = useStartTask();

  function chooseBudget(b: 10 | 20 | 30) {
    setBudget(b);
    try {
      localStorage.setItem(BUDGET_KEY, String(b));
    } catch {
      /* storage unavailable: the choice still applies to this visit */
    }
  }

  return (
    <div>
      <h1 className="mb-2 text-[28px] font-semibold leading-tight tracking-tight sm:text-[30px]">Your study workspace</h1>
      <p className="mb-5 text-[15px] text-muted">A clear starting point for your next session.</p>

      {error && !data && (
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
      )}

      {!data && !error && <HomeSkeleton />}

      {data && (
        <>
          <ProviderNotice provider={data.provider} />
          <div className="mb-3 mt-6 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-[17px] font-semibold tracking-tight">Recommended next</h2>
            <TimeBudgetControl value={budget} onChange={chooseBudget} />
          </div>

          {startError && (
            <p role="alert" className="mb-3 rounded-lg border border-red-ink/20 bg-red-soft px-4 py-3 text-sm text-red-ink">
              {startError}
            </p>
          )}

          {data.recommendation ? (
            <RecommendationCard
              task={data.recommendation}
              courseTitle={data.courses.find((c) => c.id === data.recommendation!.courseId)?.title ?? null}
              onStart={() => start(data.recommendation!)}
              busy={busy === data.recommendation.id}
            />
          ) : (
            <EmptyRecommendation data={data} />
          )}

          {data.plan.length > 0 && <StudyTaskList tasks={data.plan} totalMinutes={data.totalMinutes} onStart={start} busy={busy} />}

          {data.recentEvidence.length > 0 && <RecentEvidence rows={data.recentEvidence} />}

          {/* Future checks stay outside the actionable plan. */}
          {data.nextScheduledCheck && data.recommendation?.action !== "view" && <UpcomingCheck check={data.nextScheduledCheck} />}

          <CourseList courses={data.courses} />
        </>
      )}
    </div>
  );
}

function EmptyRecommendation({ data }: { data: HomeData }) {
  const card = "mb-6 rounded-xl border border-line bg-card p-5 shadow-[0_3px_15px_rgba(33,59,41,0.06)] sm:p-6";
  if (data.courses.length === 0) {
    return (
      <article className={card} data-testid="recommendation">
        <h3 className="text-[23px] font-semibold tracking-tight">Add your first lecture</h3>
        <p className="mt-1 text-[15px] text-muted">Import a text-based lecture PDF to draft its learning objectives.</p>
        <button
          type="button"
          onClick={openImportDialog}
          className="mt-4 inline-flex min-h-11 items-center rounded-[7px] bg-teal px-4 text-sm font-medium text-white hover:bg-teal-dark"
        >
          Import lecture
        </button>
      </article>
    );
  }
  const course = data.courses.find((c) => c.status === "approved") ?? data.courses[0];
  return (
    <article className={card} data-testid="recommendation">
      <h3 className="text-[23px] font-semibold tracking-tight">You&apos;re up to date</h3>
      <p className="mt-1 text-[15px] text-muted">Nothing is due and no check is scheduled. You can open any topic to practise.</p>
      <Link
        href={`/courses/${course.id}`}
        className="mt-4 inline-flex min-h-11 items-center rounded-[7px] bg-teal px-4 text-sm font-medium text-white hover:bg-teal-dark"
      >
        View course
      </Link>
    </article>
  );
}

function HomeSkeleton() {
  return (
    <div aria-busy="true" className="space-y-4">
      <div className="h-4 w-60 rounded bg-line/70" />
      <div className="h-[230px] rounded-xl border border-line bg-card" />
      <div className="h-[150px] rounded-[10px] border border-line bg-card" />
      <span className="sr-only" role="status">
        Loading your study plan…
      </span>
    </div>
  );
}
