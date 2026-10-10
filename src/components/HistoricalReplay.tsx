"use client";

import { useState } from "react";
import { api, ApiError } from "./api";
import { Button, Notice } from "./ui";

interface Replay {
  label: string;
  description: string;
  timeline: {
    at: string;
    day: number;
    questionId: string;
    skillObjective: string;
    phase: string;
    mode: string;
    outcome: string;
    note: string;
    evidenceLabel: string;
    stage: number | null;
    due: string | null;
    reassessmentNeeded: boolean;
  }[];
}

export function HistoricalReplay() {
  const [data, setData] = useState<Replay | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setData(await api<Replay>("/api/replay"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the example.");
    }
  }

  if (!data) {
    return (
      <div className="space-y-2">
        <Button variant="secondary" onClick={load} data-testid="open-replay">
          Open historical example (seeded)
        </Button>
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    );
  }
  return (
    <div className="space-y-3 rounded-lg border-2 border-dashed border-amber-ink/40 bg-amber-soft/40 p-4" data-testid="replay-panel">
      <p className="text-sm font-semibold uppercase tracking-wide text-amber-ink">{data.label}</p>
      <p className="text-sm text-muted">{data.description}</p>
      <ol className="space-y-3">
        {data.timeline.map((e, i) => (
          <li key={i} className="rounded-md border border-line bg-card p-3 text-sm">
            <p className="text-xs text-muted">
              Day {e.day} · {e.at} · {e.mode === "review" ? "Review checkpoint" : "Learning"}
              {e.phase === "repair" ? " · correction" : ""}
            </p>
            <p>
              <span className="font-medium">{e.questionId}</span> ({e.skillObjective}): <span className="font-medium">{e.outcome}</span> —{" "}
              {e.note}
            </p>
            <p className="text-xs">
              Evidence after this record: <strong>{e.evidenceLabel}</strong>
              {e.reassessmentNeeded ? " · needs another check" : ""}
              {e.due ? ` · next review ${e.due}` : ""}
            </p>
          </li>
        ))}
      </ol>
      <p className="text-xs text-amber-ink">{data.label}. Computed by the same rules; nothing here is stored as learner data.</p>
    </div>
  );
}
