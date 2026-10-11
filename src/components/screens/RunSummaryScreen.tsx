"use client";

import Link from "next/link";
import { ArrowRight, CalendarClock } from "lucide-react";
import type { Level } from "@/lib/domain/levels";
import { LevelPill } from "../levels";
import { useApiResource } from "../useApiResource";
import { useContinue } from "../workspace";
import { Notice } from "../ui";

interface RunData {
  id: string;
  status: "active" | "ended";
  scope: { courseId: string | null; topicId: string | null };
  steps: { position: number; kindLabel: string; title: string; topicTitle: string; state: "done" | "left" | "current" | "upcoming" | "skipped" | "not_reached" }[];
  changes: { unitId: string; title: string; topicId: string; topicTitle: string; from: Level; to: Level }[];
  moreReady: boolean;
  nextCheck: { topicId: string; topicTitle: string; focus: string; dueWhen: string } | null;
  currentSessionId: string | null;
}

const primaryBtn =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-[7px] bg-teal px-4 text-sm font-medium text-white hover:bg-teal-dark disabled:opacity-60";
const secondaryBtn =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-[7px] border border-line-strong bg-card px-4 text-sm font-medium hover:border-teal hover:text-teal";

export function RunSummaryScreen({ runId }: { runId: string }) {
  const { data, error } = useApiResource<RunData>(`/api/runs/${runId}`);
  const go = useContinue();

  if (error && !data) return <Notice tone="error">{error}</Notice>;
  if (!data) return <div aria-busy="true" className="mx-auto h-[320px] max-w-[760px] rounded-xl border border-line bg-card" />;

  if (data.status === "active" && data.currentSessionId) {
    return (
      <div className="mx-auto max-w-[760px] space-y-4">
        <h1 className="text-[26px] font-semibold tracking-tight">This session is still going</h1>
        <Link href={`/sessions/${data.currentSessionId}`} className={primaryBtn}>
          Back to the current step <ArrowRight size={16} aria-hidden="true" />
        </Link>
      </div>
    );
  }

  const done = data.steps.filter((s) => s.state === "done").length;
  const raised = data.changes.filter((c) => c.to > c.from).length;
  const moduleId = data.scope.courseId;
  return (
    <div className="mx-auto max-w-[760px] space-y-6">
      <div>
        <h1 className="text-[28px] font-semibold leading-tight tracking-tight">Session complete</h1>
        <p className="mt-1 text-[15px] text-muted">
          {done} of {data.steps.length} step{data.steps.length === 1 ? "" : "s"} done
          {raised > 0 ? ` · ${raised} subtopic${raised === 1 ? "" : "s"} moved up` : ""}.
        </p>
      </div>

      <section aria-labelledby="changes-title">
        <h2 id="changes-title" className="mb-3 text-[17px] font-semibold tracking-tight">
          What changed
        </h2>
        <ul className="overflow-hidden rounded-xl border border-line bg-card">
          {data.changes.map((c) => (
            <li key={c.unitId} className="grid gap-2 border-b border-line px-5 py-3.5 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center" data-testid={`change-${c.unitId}`}>
              <div className="min-w-0">
                <p className="font-medium">{c.title}</p>
                <p className="text-xs text-muted">{c.topicTitle}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                {c.from === c.to ? (
                  <>
                    <LevelPill level={c.to} /> no change
                  </>
                ) : (
                  <>
                    <LevelPill level={c.from} />
                    <ArrowRight size={14} aria-hidden="true" />
                    <LevelPill level={c.to} />
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted">Help counts as practice. Only first answers given with no help move a subtopic to Checked or Secure.</p>
      </section>

      <section className="rounded-xl border border-line bg-card p-5" data-testid="next-session">
        {data.moreReady ? (
          <>
            <p className="font-semibold">There&apos;s more ready now</p>
            <p className="mt-1 text-sm text-muted">Keep going, or come back later. Proximal will have the next session planned either way.</p>
          </>
        ) : data.nextCheck ? (
          <>
            <p className="flex items-center gap-2 font-semibold">
              <CalendarClock size={16} aria-hidden="true" /> Next: {data.nextCheck.dueWhen}
            </p>
            <p className="mt-1 text-sm text-muted">
              A no-help check on {data.nextCheck.focus} ({data.nextCheck.topicTitle}). It will be waiting on the overview.
            </p>
          </>
        ) : (
          <p className="font-semibold">Nothing else is due right now.</p>
        )}
        {go.error && <p className="mt-2 text-sm text-red-ink">{go.error}</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          {data.moreReady && (
            <button
              type="button"
              className={primaryBtn}
              onClick={() => go.start({ courseId: moduleId ?? undefined, topicId: data.scope.topicId ?? undefined })}
              disabled={go.busy}
              data-testid="continue-again"
            >
              {go.busy ? "Starting…" : "Keep going"} <ArrowRight size={16} aria-hidden="true" />
            </button>
          )}
          <Link href="/" className={data.moreReady ? secondaryBtn : primaryBtn} data-testid="back-to-overview">
            Back to overview
          </Link>
          {moduleId && (
            <Link href={`/courses/${moduleId}`} className={secondaryBtn}>
              See module progress
            </Link>
          )}
        </div>
      </section>
    </div>
  );
}
