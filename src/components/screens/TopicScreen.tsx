"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useApiResource } from "../useApiResource";
import { formatDateTime } from "@/lib/domain/labels";
import type { EvidenceState } from "@/lib/domain/types";
import { api, ApiError } from "../api";
import { EvidenceLabel } from "../EvidenceLabel";
import { HistoricalReplay } from "../HistoricalReplay";
import { ProviderBadge, type ProviderInfo } from "../ProviderBadge";
import { Button, Card, Loading, Notice, Pill } from "../ui";

const TZ = "Europe/London";

interface TopicData {
  provider: ProviderInfo;
  topic: { id: string; title: string };
  course: { id: string; title: string; isDemo: boolean; status: string };
  units: { id: string; title: string; objective: string; sourcePages: number[]; hasCheckedExplanation: boolean }[];
  skills: {
    id: string;
    unitId: string;
    objective: string;
    required: boolean;
    evidenceState: EvidenceState;
    reassessmentNeeded: boolean;
    lastIndependentAt: number | null;
    lastIndependentOutcome: string | null;
    dueLabel: string;
    missingApplicationCoverage: boolean;
    reviewAvailable: boolean;
    applicationSkill: boolean;
    questionStatuses: string[];
  }[];
  reviewAvailable: boolean;
  activeSessions: { id: string; mode: string; phase: string; createdAt: number }[];
  evidence: {
    attemptId: string;
    assessmentId: string | null;
    sessionMode: string;
    phase: string;
    status: string;
    submittedAt: number;
    skillId: string;
    questionId: string;
    isTransfer: boolean;
    outcome: string | null;
    excluded: boolean;
    excludedReason: string | null;
    providerMode: string | null;
    evidenceKind: "pending" | "independent" | "supported";
    exposedBeforeSubmission: boolean;
    declaredAssistance: boolean;
  }[];
}

const OUTCOME_TEXT: Record<string, string> = {
  pass: "met all essential criteria",
  partial: "partly met",
  fail: "not met",
  uncertain: "uncertain (no effect on evidence)",
};

export function TopicScreen({ topicId }: { topicId: string }) {
  const router = useRouter();
  const { data, error, reload: load } = useApiResource<TopicData>(`/api/topics/${topicId}`);
  const [actionError, setActionError] = useState<string | null>(null);
  const [starting, setStarting] = useState<"learn" | "review" | null>(null);

  async function start(mode: "learn" | "review") {
    setStarting(mode);
    setActionError(null);
    try {
      const res = await api<{ sessionId: string }>("/api/sessions", { method: "POST", json: { topicId, mode } });
      router.push(`/sessions/${res.sessionId}`);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not start the session.");
      setStarting(null);
    }
  }

  async function flag(assessmentId: string) {
    const reason = window.prompt("Why does this judgement look wrong? (It will be excluded from your evidence; history stays visible.)");
    if (!reason || reason.trim().length < 3) return;
    try {
      await api(`/api/assessments/${assessmentId}/flag`, { method: "POST", json: { reason } });
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not flag the judgement.");
    }
  }

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!data) return <Loading />;

  const skillById = new Map(data.skills.map((s) => [s.id, s]));
  const anyFixture = data.skills.some((s) => s.questionStatuses.includes("authored_fixture"));

  return (
    <div className="space-y-6">
      <ProviderBadge provider={data.provider} />
      <div>
        <Link href={`/courses/${data.course.id}`} className="text-sm text-teal hover:underline">
          ← {data.course.title}
        </Link>
        <h1 className="mt-2 font-serif text-3xl font-semibold">{data.topic.title}</h1>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => start("learn")} disabled={starting !== null} variant="secondary" data-testid="start-learn">
          {starting === "learn" ? "Starting…" : "Learn"}
        </Button>
        <Button onClick={() => start("review")} disabled={starting !== null || !data.reviewAvailable} data-testid="start-review">
          {starting === "review" ? "Starting…" : "Review (independent check)"}
        </Button>
        {!data.reviewAvailable && <Pill tone="warn">Reviewed assessment questions needed</Pill>}
      </div>
      {data.activeSessions.length > 0 && (
        <Notice title="Unfinished sessions">
          <ul className="space-y-1">
            {data.activeSessions.map((s) => (
              <li key={s.id}>
                <Link className="underline" href={`/sessions/${s.id}`}>
                  Resume {s.mode === "review" ? "review checkpoint" : "learning session"} started {formatDateTime(s.createdAt, TZ)}
                </Link>
              </li>
            ))}
          </ul>
        </Notice>
      )}
      <p className="text-xs text-muted">
        Learn explains first and gives feedback straight away; it counts as supported practice. Review is a short closed-book checkpoint:
        feedback is held back until every answer is saved. The app cannot see other tabs or notes, so it relies on you to declare outside help.
      </p>
      {!data.reviewAvailable && (
        <Notice tone="warn">
          Independent review is disabled for this topic until an owner-authored, reviewed question bank is attached (see the README:
          <code className="mx-1">npm run questions:import</code>). Imported objectives are never auto-mapped to demo questions.
        </Notice>
      )}
      {anyFixture && (
        <p className="text-xs text-muted">Questions here are authored fixtures that the owner has not yet reviewed.</p>
      )}
      {actionError && <Notice tone="error">{actionError}</Notice>}

      <div className="space-y-4">
        {data.units.map((u) => (
          <Card key={u.id}>
            <h2 className="font-serif text-lg font-semibold">{u.title}</h2>
            <p className="text-sm text-muted">
              Objective: {u.objective} · source PDF page{u.sourcePages.length > 1 ? "s" : ""} {u.sourcePages.join(", ")}
            </p>
            <ul className="mt-3 space-y-3">
              {data.skills
                .filter((s) => s.unitId === u.id)
                .map((s) => (
                  <li key={s.id} className="rounded-lg border border-line p-3" data-testid={`skill-${s.id}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{s.objective}</span>
                      <EvidenceLabel state={s.evidenceState} />
                      {s.reassessmentNeeded && (
                        <Pill tone="warn">{s.applicationSkill ? "Application needs another check" : "Needs another independent check"}</Pill>
                      )}
                      {!s.required && <Pill>Optional</Pill>}
                    </div>
                    <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs text-muted sm:grid-cols-3">
                      <div>
                        <dt className="inline font-medium">Last independent check: </dt>
                        <dd className="inline">
                          {s.lastIndependentAt
                            ? `${formatDateTime(s.lastIndependentAt, TZ)} (${OUTCOME_TEXT[s.lastIndependentOutcome ?? ""] ?? s.lastIndependentOutcome})`
                            : "none yet"}
                        </dd>
                      </div>
                      <div>
                        <dt className="inline font-medium">Next: </dt>
                        <dd className="inline" data-testid={`due-${s.id}`}>
                          {s.dueLabel}
                        </dd>
                      </div>
                      <div>
                        <dt className="inline font-medium">New-context coverage: </dt>
                        <dd className="inline">{s.missingApplicationCoverage ? "still needed" : "covered"}</dd>
                      </div>
                    </dl>
                  </li>
                ))}
            </ul>
          </Card>
        ))}
      </div>

      <Card>
        <h2 className="font-serif text-lg font-semibold">Evidence history</h2>
        {data.evidence.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No answers recorded yet.</p>
        ) : (
          <ol className="mt-3 space-y-2 text-sm" data-testid="evidence-list">
            {data.evidence.map((e) => (
              <li key={e.attemptId} className={`rounded-md border border-line p-2 ${e.excluded ? "opacity-60" : ""}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted">{formatDateTime(e.submittedAt, TZ)}</span>
                  <span className="font-medium">{e.questionId}</span>
                  <span className="text-muted">{skillById.get(e.skillId)?.objective}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                  <Pill tone={e.evidenceKind === "independent" ? "good" : e.evidenceKind === "supported" ? "info" : "neutral"}>
                    {e.evidenceKind === "independent" ? "Independent" : e.evidenceKind === "supported" ? "Supported" : "Pending"}
                  </Pill>
                  <span>{e.sessionMode === "review" ? (e.phase === "repair" ? "Review correction" : "Review checkpoint") : "Learning"}</span>
                  {e.isTransfer && <Pill>New-context question</Pill>}
                  <span>Result: {e.outcome ? OUTCOME_TEXT[e.outcome] : e.status === "provider_error" ? "assessment failed (retry available)" : "awaiting assessment"}</span>
                  {e.exposedBeforeSubmission && <span className="text-muted">· help seen before answering</span>}
                  {e.declaredAssistance && <span className="text-muted">· outside help declared</span>}
                  {e.providerMode && <span className="text-muted">· judged by {e.providerMode === "mock" ? "offline fixture" : e.providerMode === "rule" ? "rule (I don't know)" : "live Claude"}</span>}
                  {e.excluded ? (
                    <Pill tone="warn">Flagged and excluded: {e.excludedReason}</Pill>
                  ) : (
                    e.assessmentId && (
                      <button className="text-teal underline" onClick={() => flag(e.assessmentId!)}>
                        Flag judgement
                      </button>
                    )
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>

      {data.course.isDemo && data.topic.id === "demo-topic-bce" && (
        <Card>
          <h2 className="font-serif text-lg font-semibold">What a later review looks like</h2>
          <p className="mt-1 text-sm text-muted">
            Real reviews need at least 24 elapsed hours. This seeded example shows the same rules applied to recorded example dates.
          </p>
          <div className="mt-3">
            <HistoricalReplay />
          </div>
        </Card>
      )}
    </div>
  );
}
