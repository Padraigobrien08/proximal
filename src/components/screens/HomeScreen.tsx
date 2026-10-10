"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  Clock3,
  Info,
  Layers,
  LayoutDashboard,
  Plus,
  Sparkles,
} from "lucide-react";
import type { QueueReasonCode } from "@/lib/domain/scheduler";
import { ImportPanel } from "../ImportPanel";
import { ProviderBadge, type ProviderInfo } from "../ProviderBadge";
import { useApiResource } from "../useApiResource";

interface QueueItem {
  skillId: string;
  objective: string;
  reason: QueueReasonCode;
  reasonText: string;
  dueLabel: string | null;
  suggestedMode: "learn" | "review";
}

interface QueueBlock {
  topicId: string;
  topicTitle: string;
  estimatedMinutes: number;
  reasons: string[];
  course: { id: string; title: string } | null;
  items: QueueItem[];
}

interface CourseSummary {
  id: string;
  title: string;
  isDemo: boolean;
  status: "draft" | "approved";
  topics: { id: string; title: string }[];
  topicCount: number;
  skillCount: number;
  independentCount: number;
  sourceLabel: string | null;
}

interface HomeData {
  provider: ProviderInfo;
  budgetMinutes: number;
  minutesPerQuestion: number;
  queue: QueueBlock[];
  courses: CourseSummary[];
}

type View = "overview" | "courses" | "import";

const BUDGET_KEY = "proximal.budget";
const BUDGETS = [10, 20, 30] as const;
const VIEW_LABEL: Record<View, string> = { overview: "Overview", courses: "Courses", import: "Import lecture" };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Short lead for the recommended block, derived from its highest-priority queue reason. */
function recommendationLead(block: QueueBlock, courses: CourseSummary[]): string {
  switch (block.items[0]?.reason) {
    case "reassessment_due":
      return "Another independent check is due";
    case "review_due":
      return "Scheduled review is due";
    case "missing_independent":
      return "Not yet shown without help";
    case "missing_application":
      return "Needs a check in a new context";
    default: {
      const course = courses.find((c) => c.id === block.course?.id);
      return course?.topics[0]?.id === block.topicId ? "Start with the foundations" : "Start something new";
    }
  }
}

function blockSummary(block: QueueBlock): string {
  const due = block.items.find((i) => i.dueLabel)?.dueLabel;
  return [...block.reasons, ...(due ? [due] : [])].join(" · ");
}

export function HomeScreen() {
  const [budget, setBudget] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem(BUDGET_KEY));
      return (BUDGETS as readonly number[]).includes(saved) ? saved : 20;
    } catch {
      return 20;
    }
  });
  const [view, setView] = useState<View>("overview");
  const { data, error } = useApiResource<HomeData>(`/api/home?budget=${budget}`);

  function chooseBudget(b: number) {
    setBudget(b);
    try {
      localStorage.setItem(BUDGET_KEY, String(b));
    } catch {
      /* storage unavailable: the choice still applies to this visit */
    }
  }

  return (
    <div className="min-h-screen bg-ws-bg text-ws-ink sm:grid sm:grid-cols-[162px_minmax(0,1fr)] lg:grid-cols-[196px_minmax(0,1fr)]">
      <Sidebar view={view} onView={setView} data={data} />

      <main id="main" className="min-w-0 px-4 pb-8 sm:px-6 lg:px-9">
        <div className="mx-auto max-w-3xl">
          <header className="mb-7 flex min-h-[65px] flex-wrap items-center justify-between gap-4 border-b border-ws-line py-3.5 sm:min-h-[73px]">
            <p className="flex items-center gap-2 text-xs text-ws-muted">
              Workspace <span aria-hidden="true">/</span>
              <span className="font-medium text-ws-ink" aria-current="page">
                {VIEW_LABEL[view]}
              </span>
            </p>
            <WsButton
              onClick={() => setView(view === "import" ? "overview" : "import")}
              aria-expanded={view === "import"}
              data-testid="toggle-import"
            >
              <Plus size={16} aria-hidden="true" />
              Import lecture
            </WsButton>
          </header>

          {error && (
            <p role="alert" className="rounded-lg border border-red-ink/20 bg-red-soft px-4 py-3 text-sm text-red-ink">
              {error}
            </p>
          )}
          {!data && !error && (
            <p role="status" className="py-10 text-center text-sm text-ws-muted">
              Loading your workspace…
            </p>
          )}

          {data && view === "import" && <ImportView onBack={() => setView("overview")} />}

          {data && view === "overview" && (
            <Overview data={data} budget={budget} onBudget={chooseBudget} />
          )}

          {data && view !== "import" && <CoursesSection courses={data.courses} asPage={view === "courses"} />}
        </div>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------- sidebar

function Sidebar({ view, onView, data }: { view: View; onView: (v: View) => void; data: HomeData | null }) {
  const footer =
    data?.provider.mode === "mock"
      ? "Offline demo · example content"
      : data?.provider.ready
        ? `Live Claude · ${data.provider.model}`
        : data
          ? "Live mode unavailable"
          : "";
  return (
    <aside
      aria-label="Workspace navigation"
      className="flex items-center justify-between gap-3 bg-ws-side px-5 py-4 text-ws-side-ink sm:sticky sm:top-0 sm:h-screen sm:flex-col sm:items-stretch sm:justify-start sm:gap-7 sm:px-3 sm:py-6 lg:px-4"
    >
      <Link href="/" className="flex items-center gap-2.5 px-2 text-[21px] font-semibold tracking-tight lg:text-2xl">
        <span aria-hidden="true" className="grid size-[26px] place-items-center rounded-lg bg-ws-side-ink text-[19px] font-medium text-ws-side">
          p
        </span>
        Proximal
      </Link>
      <nav aria-label="Workspace views" className="flex gap-0.5 sm:flex-col sm:gap-1.5">
        {(
          [
            ["overview", "Overview", LayoutDashboard],
            ["courses", "Courses", BookOpen],
          ] as const
        ).map(([key, label, Icon]) => (
          <button
            key={key}
            type="button"
            aria-pressed={view === key}
            onClick={() => onView(key)}
            className={`flex min-h-11 items-center gap-2.5 rounded-lg px-2 text-left text-xs transition-colors motion-reduce:transition-none sm:px-3 sm:text-sm ${
              view === key ? "bg-ws-side-active text-ws-side-ink" : "text-ws-side-muted hover:text-ws-side-ink"
            }`}
          >
            <Icon size={17} aria-hidden="true" className="hidden sm:block" />
            {label}
          </button>
        ))}
      </nav>
      <div className="hidden sm:block">
        <p className="mb-2.5 px-2.5 text-[11px] font-medium uppercase tracking-[0.1em] text-ws-side-muted">Your courses</p>
        <ul className="space-y-1.5 px-2.5 text-[13px]">
          {data?.courses.map((c) => (
            <li key={c.id}>
              <Link href={`/courses/${c.id}`} className="text-ws-side-ink hover:underline">
                {c.title}
              </Link>
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-auto hidden border-t border-ws-side-active px-2.5 pt-6 text-xs text-ws-side-muted sm:block">
        <strong className="mb-0.5 block font-medium text-ws-side-ink">Personal workspace</strong>
        {footer}
        <span className="mt-1 block">Local only · 127.0.0.1</span>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------- overview

function Overview({ data, budget, onBudget }: { data: HomeData; budget: number; onBudget: (b: number) => void }) {
  const [next, ...rest] = data.queue;
  const totalMinutes = data.queue.reduce((n, b) => n + b.estimatedMinutes, 0);
  return (
    <section aria-labelledby="ws-title">
      <h1 id="ws-title" className="mb-2 text-[27px] font-semibold leading-tight tracking-tight sm:text-[30px]">
        Your study workspace
      </h1>
      <p className="mb-5 text-sm text-ws-muted">A clear starting point for your next session.</p>

      <ModeNote provider={data.provider} />

      <div className="mb-3 mt-6 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[17px] font-semibold tracking-tight">Recommended next</h2>
        <div role="group" aria-label="Study time" className="flex gap-0.5 rounded-lg border border-ws-line bg-ws-paper p-[3px]">
          {BUDGETS.map((b) => (
            <button
              key={b}
              type="button"
              aria-pressed={budget === b}
              onClick={() => onBudget(b)}
              className={`min-h-8 rounded-[5px] px-2.5 text-xs transition-colors motion-reduce:transition-none ${
                budget === b ? "bg-ws-wash font-medium text-ws-green" : "text-ws-muted hover:text-ws-ink"
              }`}
            >
              {b} min
            </button>
          ))}
        </div>
      </div>

      {next ? (
        <RecommendedCard block={next} lead={recommendationLead(next, data.courses)} />
      ) : (
        <article className="mb-6 rounded-xl border border-ws-line bg-ws-paper p-6 shadow-[0_3px_15px_rgba(33,59,41,0.06)]">
          <p className="font-medium">Nothing is due and no evidence is missing right now.</p>
          <p className="mt-1 text-sm text-ws-muted">Open any course below to study a topic of your choice.</p>
        </article>
      )}

      {data.queue.length > 0 && (
        <section aria-labelledby="ws-plan" className="mb-7">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 id="ws-plan" className="text-[17px] font-semibold tracking-tight">
              Your session plan
            </h2>
            <span className="text-xs text-ws-muted" aria-live="polite">
              {plural(data.queue.length, "topic")} · about {totalMinutes} minutes
            </span>
          </div>
          <ol className="overflow-hidden rounded-[10px] border border-ws-line bg-ws-paper">
            {[next, ...rest].map((b, i) => (
              <PlanRow key={b.topicId} index={i + 1} block={b} />
            ))}
          </ol>
        </section>
      )}
    </section>
  );
}

function RecommendedCard({ block, lead }: { block: QueueBlock; lead: string }) {
  return (
    <article
      aria-labelledby="ws-next-title"
      className="mb-6 rounded-xl border border-ws-line bg-ws-paper p-5 shadow-[0_3px_15px_rgba(33,59,41,0.06)] sm:p-6"
    >
      <p className="inline-flex items-center gap-1.5 text-xs font-medium text-ws-green">
        <Sparkles size={15} aria-hidden="true" />
        {lead}
      </p>
      <h3 id="ws-next-title" className="mb-2 mt-3 text-[23px] font-semibold leading-tight tracking-tight sm:text-[25px]">
        {block.topicTitle}
      </h3>
      <ul className="max-w-[470px] space-y-0.5 text-sm text-ws-muted">
        {block.items.map((i) => (
          <li key={i.skillId}>{i.objective}</li>
        ))}
      </ul>
      <div className="my-5 flex flex-wrap items-center gap-4 text-xs text-ws-muted">
        <span className="inline-flex items-center gap-1.5">
          <Clock3 size={14} aria-hidden="true" />
          About {block.estimatedMinutes} minutes
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Layers size={14} aria-hidden="true" />
          {plural(block.items.length, "skill")}
        </span>
        {block.course && <span>{block.course.title}</span>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ws-line pt-4">
        <span className="text-xs text-ws-muted">{blockSummary(block)}</span>
        <Link
          href={`/topics/${block.topicId}`}
          className="inline-flex min-h-10 items-center gap-2 rounded-[7px] border border-ws-green bg-ws-green px-3.5 text-sm font-medium text-white transition-colors hover:bg-ws-green-dark motion-reduce:transition-none"
        >
          Open topic
          <ArrowRight size={16} aria-hidden="true" />
        </Link>
      </div>
    </article>
  );
}

function PlanRow({ index, block }: { index: number; block: QueueBlock }) {
  return (
    <li className="grid grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-2 border-b border-ws-line px-3.5 py-3.5 last:border-b-0 sm:grid-cols-[28px_minmax(0,1fr)_auto] sm:gap-3 sm:px-[18px] sm:py-4">
      <span aria-hidden="true" className="grid size-[26px] place-items-center rounded-[7px] bg-ws-bg text-xs text-ws-muted">
        {index}
      </span>
      <div className="min-w-0">
        <p className="mb-0.5 font-medium">{block.topicTitle}</p>
        <p className="text-xs text-ws-muted">
          {plural(block.items.length, "skill")} · {blockSummary(block)}
        </p>
      </div>
      <Link
        href={`/topics/${block.topicId}`}
        aria-label={`Open ${block.topicTitle}, about ${block.estimatedMinutes} minutes`}
        className="flex min-h-11 items-center gap-1 pl-2 text-xs text-ws-muted hover:text-ws-green sm:gap-2"
      >
        <span>{block.estimatedMinutes} min</span>
        <ChevronRight size={16} aria-hidden="true" />
      </Link>
    </li>
  );
}

/** Provider mode stays visible but restrained; a misconfigured live mode remains a prominent alert. */
function ModeNote({ provider }: { provider: ProviderInfo }) {
  const [open, setOpen] = useState(false);
  if (provider.mode === "live" && !provider.ready) return <ProviderBadge provider={provider} />;
  const mock = provider.mode === "mock";
  return (
    <div data-testid="provider-badge">
      <p className="flex flex-wrap items-center gap-2 text-xs text-ws-muted">
        <Info size={15} aria-hidden="true" />
        <span>{mock ? "Offline demo · example answers only." : `Live Claude mode · ${provider.model}.`}</span>
        <button
          type="button"
          aria-expanded={open}
          aria-controls="ws-mode-detail"
          onClick={() => setOpen((o) => !o)}
          className="text-ws-green underline underline-offset-[3px]"
        >
          Details
        </button>
      </p>
      <p
        id="ws-mode-detail"
        hidden={!open}
        className="mt-2.5 rounded-[7px] bg-ws-amber-bg px-4 py-3 text-xs text-ws-amber"
      >
        {mock
          ? "Only the supplied example answers can be assessed in offline mode. Other answers are marked uncertain and do not change your evidence; AI grading is not active."
          : "AI judgements are checked against the rubric on the server, can be uncertain, and can be flagged. A live failure never falls back to the offline demo."}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- courses & import

function CoursesSection({ courses, asPage }: { courses: CourseSummary[]; asPage: boolean }) {
  // In the Courses view this section is the page, so its heading is the page's h1.
  const Heading = asPage ? "h1" : "h2";
  return (
    <section aria-labelledby="ws-courses" id="courses">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <Heading
          id="ws-courses"
          className={asPage ? "text-[27px] font-semibold leading-tight tracking-tight sm:text-[30px]" : "text-[17px] font-semibold tracking-tight"}
        >
          Your courses
        </Heading>
        <span className="text-xs text-ws-muted">{plural(courses.length, "course")}</span>
      </div>
      {courses.length === 0 ? (
        <p className="rounded-[10px] border border-ws-line bg-ws-paper p-5 text-sm text-ws-muted">
          No courses yet. Run <code>npm run db:seed</code> for the demo, or import a lecture PDF.
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

function CourseCard({ course }: { course: CourseSummary }) {
  const draft = course.status === "draft";
  const details = [plural(course.topicCount, "topic"), plural(course.skillCount, "skill"), course.sourceLabel?.toLowerCase()]
    .filter(Boolean)
    .join(" · ");
  const EvidenceIcon = course.independentCount > 0 ? CircleCheck : CircleDashed;
  return (
    <article
      aria-labelledby={`course-${course.id}`}
      className="grid grid-cols-[36px_minmax(0,1fr)] items-center gap-3 rounded-[10px] border border-ws-line bg-ws-paper p-5 sm:grid-cols-[42px_minmax(0,1fr)_auto] sm:gap-4"
    >
      <span aria-hidden="true" className="grid h-[46px] w-9 place-items-center rounded-lg bg-ws-wash text-ws-green sm:w-[42px]">
        <BookOpen size={20} />
      </span>
      <div className="min-w-0">
        <h3 id={`course-${course.id}`} className="mb-1 text-[15px] font-semibold">
          {course.title}
        </h3>
        <p className="text-xs text-ws-muted">{details}</p>
      </div>
      <Link
        href={`/courses/${course.id}`}
        className="col-start-2 inline-flex min-h-10 items-center gap-1.5 justify-self-start text-sm font-medium text-ws-green hover:underline sm:col-start-auto sm:justify-self-auto"
      >
        {draft ? "Review draft" : "Open course"}
        <ArrowUpRight size={16} aria-hidden="true" />
      </Link>
      <p className="col-span-full flex flex-wrap items-center gap-2 border-t border-ws-line pt-3.5 text-xs text-ws-muted sm:col-start-2">
        <EvidenceIcon size={15} aria-hidden="true" />
        {draft
          ? "Objectives need your approval before study"
          : `${course.independentCount} of ${plural(course.skillCount, "skill")} checked independently`}
        <span className="whitespace-nowrap rounded-[5px] bg-ws-bg px-2 py-0.5 text-[11px]">
          {course.isDemo ? "Demo content" : draft ? "Draft" : "Imported"}
        </span>
      </p>
    </article>
  );
}

function ImportView({ onBack }: { onBack: () => void }) {
  return (
    <section aria-labelledby="ws-import" className="mb-8">
      <button
        type="button"
        onClick={onBack}
        className="mb-3 inline-flex min-h-10 items-center gap-1.5 text-sm font-medium text-ws-green"
      >
        <ArrowLeft size={16} aria-hidden="true" />
        Back to overview
      </button>
      <h1 id="ws-import" className="mb-1 text-[27px] font-semibold leading-tight tracking-tight sm:text-[30px]">
        Import a lecture
      </h1>
      <p className="text-xs text-ws-muted">Add a lecture PDF to organise its learning objectives.</p>
      <div className="mt-5 rounded-xl border border-ws-line bg-ws-paper p-5 sm:p-6">
        <h2 className="mb-3 text-[17px] font-semibold tracking-tight">Choose your material</h2>
        <ImportPanel />
      </div>
    </section>
  );
}

function WsButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { "data-testid"?: string }) {
  return (
    <button
      type="button"
      {...props}
      className="inline-flex min-h-10 items-center justify-center gap-2 whitespace-nowrap rounded-[7px] border border-ws-line bg-ws-paper px-3.5 text-sm font-medium text-ws-ink transition-colors hover:border-ws-green hover:text-ws-green motion-reduce:transition-none"
    >
      {children}
    </button>
  );
}
