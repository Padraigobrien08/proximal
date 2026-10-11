"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowUpRight, Info } from "lucide-react";
import type { ActionKind } from "@/lib/domain/plan";
import { vendorName } from "@/lib/domain/labels";
import type { Level, LevelRollup } from "@/lib/domain/levels";
import { api, ApiError } from "./api";
import { notifyDataChanged } from "./dataEvents";
import { LevelBar, LevelCounts, LevelLegend, rollupSentence } from "./levels";
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
  /** Subtopic titles joined with " · ". */
  subtopicTitles: string;
  kind: ActionKind;
  kindLabel: string;
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
  mastery: LevelRollup;
  subtopicLevels: { level: Level; due: boolean }[];
}

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

/** Session length in minutes: 5-minute steps from 5 to 60 (see SESSION_MINUTES on the server). */
export type Budget = number;
const BUDGET_KEY = "proximal.budget";
export const DEFAULT_BUDGET = 25;

export function clampBudget(m: number): Budget {
  if (!Number.isFinite(m)) return DEFAULT_BUDGET;
  return Math.min(60, Math.max(5, Math.round(m / 5) * 5));
}

export function readBudget(): Budget {
  try {
    const saved = localStorage.getItem(BUDGET_KEY);
    return saved === null ? DEFAULT_BUDGET : clampBudget(Number(saved));
  } catch {
    return DEFAULT_BUDGET;
  }
}

export function saveBudget(b: Budget) {
  try {
    localStorage.setItem(BUDGET_KEY, String(b));
  } catch {
    /* storage unavailable: the choice still applies to this visit */
  }
}

/** Continue: freeze the current plan (optionally for one module or topic) and open its first step. */
export function useContinue() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function start(opts: { budgetMinutes?: Budget; courseId?: string; topicId?: string } = {}) {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ runId: string; sessionId: string | null }>("/api/runs", {
        method: "POST",
        json: { budgetMinutes: opts.budgetMinutes ?? readBudget(), courseId: opts.courseId, topicId: opts.topicId },
      });
      notifyDataChanged();
      router.push(res.sessionId ? `/sessions/${res.sessionId}` : `/runs/${res.runId}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start a session.");
      setBusy(false);
    }
  }
  return { start, busy, error };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function ModuleList({ modules, headingLevel = "h2" }: { modules: CourseSummaryView[]; headingLevel?: "h1" | "h2" }) {
  const Heading = headingLevel;
  return (
    <section aria-labelledby="modules-title" id="modules">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <Heading
          id="modules-title"
          className={headingLevel === "h1" ? "text-[28px] font-semibold leading-tight tracking-tight sm:text-[30px]" : "text-[17px] font-semibold tracking-tight"}
        >
          Your modules
        </Heading>
        {modules.length > 0 && <LevelLegend />}
      </div>
      {modules.length === 0 ? (
        <p className="rounded-[10px] border border-line bg-card p-5 text-sm text-muted">
          No modules yet. Use Import lecture above, or run <code>npm run db:seed</code> for the sample module.
        </p>
      ) : (
        <div className="space-y-3">
          {modules.map((c) => (
            <ModuleCard key={c.id} module={c} />
          ))}
        </div>
      )}
    </section>
  );
}

function ModuleCard({ module: m }: { module: CourseSummaryView }) {
  const draft = m.status === "draft";
  const details = [plural(m.topicCount, "topic"), plural(m.mastery.total, "subtopic"), m.sourceLabel].filter(Boolean).join(" · ");
  return (
    <article aria-labelledby={`module-${m.id}`} data-testid={`course-${m.id}`} className="space-y-3 rounded-[10px] border border-line bg-card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <h3 id={`module-${m.id}`} className="text-[15px] font-semibold">
            {m.title}
          </h3>
          <p className="text-xs text-muted">
            {details}
            {m.isDemo && " · demo content"}
          </p>
        </div>
        <Link href={`/courses/${m.id}`} className="inline-flex min-h-10 items-center gap-1.5 text-sm font-medium text-teal hover:underline">
          {draft ? "Review draft" : "Open module"}
          <ArrowUpRight size={16} aria-hidden="true" />
        </Link>
      </div>
      {draft ? (
        <p className="text-xs text-muted">Objectives need your approval before study.</p>
      ) : (
        <>
          <p className="text-sm">
            <strong className="font-semibold">
              {m.mastery.checked} of {m.mastery.total}
            </strong>{" "}
            subtopics checked on your own
          </p>
          <LevelBar subtopics={m.subtopicLevels} label={rollupSentence(m.mastery)} />
          <LevelCounts rollup={m.mastery} />
        </>
      )}
    </article>
  );
}
