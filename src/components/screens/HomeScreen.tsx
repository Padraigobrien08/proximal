"use client";

import Link from "next/link";
import { useState } from "react";
import { useApiResource } from "../useApiResource";
import { ImportPanel } from "../ImportPanel";
import { ProviderBadge, type ProviderInfo } from "../ProviderBadge";
import { ButtonLink, Card, Loading, Notice, Pill } from "../ui";

interface HomeData {
  provider: ProviderInfo;
  budgetMinutes: number;
  minutesPerQuestion: number;
  queue: {
    topicId: string;
    topicTitle: string;
    estimatedMinutes: number;
    reasons: string[];
    items: { skillId: string; objective: string; reasonText: string; dueLabel: string | null; suggestedMode: "learn" | "review" }[];
  }[];
  courses: { id: string; title: string; isDemo: boolean; status: "draft" | "approved"; topics: { id: string; title: string }[] }[];
}

const BUDGET_KEY = "proximal.budget";

export function HomeScreen() {
  const [budget, setBudget] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(BUDGET_KEY));
      return [10, 20, 30].includes(saved) ? saved : 20;
    } catch {
      return 20;
    }
  });
  const { data, error } = useApiResource<HomeData>(`/api/home?budget=${budget}`);
  const [showImport, setShowImport] = useState(false);

  function chooseBudget(b: number) {
    setBudget(b);
    try {
      localStorage.setItem(BUDGET_KEY, String(b));
    } catch {
      /* ignore */
    }
  }

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!data) return <Loading />;

  const demo = data.courses.find((c) => c.isDemo);
  const imports = data.courses.filter((c) => !c.isDemo);

  return (
    <div className="space-y-8">
      <ProviderBadge provider={data.provider} />

      <section aria-labelledby="today" className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 id="today" className="font-serif text-3xl font-semibold">
              What to study now
            </h1>
            <p className="text-sm text-muted">
              Up to three topic blocks, chosen from due reviews and missing evidence. About {data.minutesPerQuestion} minutes per question.
            </p>
          </div>
          <fieldset className="flex items-center gap-1 rounded-lg border border-line bg-card p-1" aria-label="Time budget">
            <legend className="sr-only">Time budget</legend>
            {[10, 20, 30].map((b) => (
              <label key={b} className={`cursor-pointer rounded-md px-3 py-1.5 text-sm ${budget === b ? "bg-teal text-white" : "text-ink"}`}>
                <input type="radio" name="budget" value={b} checked={budget === b} onChange={() => chooseBudget(b)} className="sr-only" />
                {b} min
              </label>
            ))}
          </fieldset>
        </div>

        {data.queue.length === 0 ? (
          <Card>
            <p className="text-sm text-muted">Nothing is due and no evidence is missing right now. You can open any topic below.</p>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-3">
            {data.queue.map((block) => (
              <Card key={block.topicId} className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-2">
                  <h2 className="font-serif text-lg font-semibold">{block.topicTitle}</h2>
                  <Pill tone="teal">~{block.estimatedMinutes} min</Pill>
                </div>
                <ul className="space-y-2 text-sm">
                  {block.items.map((i) => (
                    <li key={i.skillId}>
                      <p>{i.objective}</p>
                      <p className="text-xs text-muted">
                        {i.reasonText}
                        {i.dueLabel ? ` · ${i.dueLabel}` : ""}
                      </p>
                    </li>
                  ))}
                </ul>
                <div className="mt-auto">
                  <ButtonLink href={`/topics/${block.topicId}`}>Open topic</ButtonLink>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="courses" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="courses" className="font-serif text-2xl font-semibold">
            Courses
          </h2>
          <div className="flex gap-2">
            {demo && (
              <ButtonLink href={`/courses/${demo.id}`} variant="secondary">
                Open demo
              </ButtonLink>
            )}
            <button
              type="button"
              onClick={() => setShowImport((s) => !s)}
              aria-expanded={showImport}
              className="rounded-lg bg-teal px-4 py-2 text-sm font-medium text-white hover:bg-teal-dark"
              data-testid="toggle-import"
            >
              Import PDF
            </button>
          </div>
        </div>
        {showImport && (
          <Card>
            <h3 className="mb-2 font-semibold">Import a lecture PDF</h3>
            <ImportPanel />
          </Card>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          {demo && (
            <Card>
              <div className="flex items-center gap-2">
                <h3 className="font-semibold">{demo.title}</h3>
                <Pill tone="warn">Demo · authored fixtures</Pill>
              </div>
              <ul className="mt-3 space-y-1 text-sm">
                {demo.topics.map((t) => (
                  <li key={t.id}>
                    <Link className="text-teal hover:underline" href={`/topics/${t.id}`}>
                      {t.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {imports.map((c) => (
            <Card key={c.id}>
              <div className="flex items-center gap-2">
                <h3 className="font-semibold">{c.title}</h3>
                <Pill tone={c.status === "draft" ? "warn" : "info"}>{c.status === "draft" ? "Draft – needs approval" : "Approved import"}</Pill>
              </div>
              {c.status === "draft" ? (
                <Link className="mt-3 inline-block text-sm text-teal hover:underline" href={`/courses/${c.id}`}>
                  Review draft
                </Link>
              ) : (
                <ul className="mt-3 space-y-1 text-sm">
                  {c.topics.map((t) => (
                    <li key={t.id}>
                      <Link className="text-teal hover:underline" href={`/topics/${t.id}`}>
                        {t.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}
