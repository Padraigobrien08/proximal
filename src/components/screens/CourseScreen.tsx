"use client";

import Link from "next/link";
import { useState } from "react";
import { useApiResource } from "../useApiResource";
import { api, ApiError } from "../api";
import { ProviderBadge, type ProviderInfo } from "../ProviderBadge";
import { Button, ButtonLink, Card, Loading, Notice, Pill } from "../ui";

interface CourseData {
  provider: ProviderInfo;
  course: { id: string; title: string; isDemo: boolean; status: "draft" | "approved"; suggestions: string[]; notice: string | null };
  sources: {
    id: string;
    label: string;
    originalName: string;
    status: string;
    pageCount: number | null;
    pages: { page: number; lowTextWarning: boolean; charCount: number; text: string | null }[];
  }[];
  topics: {
    id: string;
    title: string;
    units: {
      id: string;
      title: string;
      objective: string;
      version: number;
      approvalStatus: string;
      sourcePages: number[];
      skills: { id: string; objective: string; required: boolean; frozen: boolean; reviewAvailable: boolean }[];
    }[];
  }[];
}

type UnitEdit = { title?: string; objective?: string; delete?: boolean; skills: Record<string, { objective?: string; required?: boolean }> };

export function CourseScreen({ courseId }: { courseId: string }) {
  const { data, error, reload: load, setData } = useApiResource<CourseData>(`/api/courses/${courseId}`);
  const [notice, setNotice] = useState<{ tone: "good" | "error" | "warn"; text: string } | null>(null);
  const [edits, setEdits] = useState<Record<string, UnitEdit>>({});
  const [adding, setAdding] = useState({ topicTitle: "", title: "", objective: "", pages: "" });
  const [busy, setBusy] = useState(false);

  const dirty = Object.keys(edits).length > 0;
  const editUnit = (unitId: string, patch: Partial<UnitEdit>) =>
    setEdits((e) => ({ ...e, [unitId]: { ...e[unitId], ...patch, skills: { ...e[unitId]?.skills, ...patch.skills } } }));
  const editSkill = (unitId: string, skillId: string, patch: { objective?: string; required?: boolean }) =>
    setEdits((e) => {
      const u = e[unitId] ?? { skills: {} };
      return { ...e, [unitId]: { ...u, skills: { ...u.skills, [skillId]: { ...u.skills[skillId], ...patch } } } };
    });

  async function save(extra?: { addUnits?: { topicTitle: string; title: string; objective: string; sourcePages: number[] }[] }) {
    setBusy(true);
    try {
      const units = Object.entries(edits).map(([unitId, e]) => ({
        unitId,
        ...(e.title !== undefined ? { title: e.title } : {}),
        ...(e.objective !== undefined ? { objective: e.objective } : {}),
        ...(e.delete ? { delete: true } : {}),
        skills: Object.entries(e.skills).map(([skillId, s]) => ({ skillId, ...s })),
      }));
      setData(await api<CourseData>(`/api/courses/${courseId}/draft`, { method: "PATCH", json: { units, addUnits: extra?.addUnits ?? [] } }));
      setEdits({});
      setNotice({ tone: "good", text: "Draft saved." });
      return true;
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof ApiError ? err.message : "Save failed." });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addObjective() {
    const pages = adding.pages
      .split(/[,\s]+/)
      .filter(Boolean)
      .map(Number);
    if (!adding.topicTitle || !adding.title || !adding.objective || pages.length === 0 || pages.some((p) => !Number.isInteger(p))) {
      setNotice({ tone: "error", text: "Fill in topic, title, objective and at least one source page number." });
      return;
    }
    if (await save({ addUnits: [{ topicTitle: adding.topicTitle, title: adding.title, objective: adding.objective, sourcePages: pages }] })) {
      setAdding({ topicTitle: adding.topicTitle, title: "", objective: "", pages: "" });
    }
  }

  async function revise(unitId: string, current: string) {
    const objective = window.prompt(
      "Revised objective. This creates a new version of the unit with fresh evidence; the old version and its history are kept.",
      current,
    );
    if (!objective || objective.trim() === current) return;
    setBusy(true);
    try {
      setData(await api<CourseData>(`/api/courses/${courseId}/draft`, { method: "PATCH", json: { revisions: [{ unitId, objective }] } }));
      setNotice({ tone: "good", text: "Objective revised as a new version. Evidence for the new version starts fresh." });
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof ApiError ? err.message : "Revision failed." });
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    setBusy(true);
    try {
      await api(`/api/courses/${courseId}/approve`, { method: "POST", json: {} });
      setNotice({ tone: "good", text: "Curriculum approved. Objectives are now frozen." });
      load();
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof ApiError ? err.message : "Approval failed." });
    } finally {
      setBusy(false);
    }
  }

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!data) return <Loading />;
  const draft = data.course.status === "draft";

  return (
    <div className="space-y-6">
      <ProviderBadge provider={data.provider} />
      <div>
        <Link href="/" className="text-sm text-teal hover:underline">
          ← Home
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="font-serif text-3xl font-semibold">{data.course.title}</h1>
          {data.course.isDemo && <Pill tone="warn">Demo course</Pill>}
          <Pill tone={draft ? "warn" : "good"}>{draft ? "Draft – not yet approved" : "Approved"}</Pill>
        </div>
        {data.course.notice && <p className="mt-1 text-sm text-muted">{data.course.notice}</p>}
      </div>

      {notice && <Notice tone={notice.tone === "good" ? "good" : notice.tone}>{notice.text}</Notice>}

      {draft && (
        <Notice tone="warn" title="Review this draft before approving">
          Generated or fixture objectives are a draft. Edit titles and objectives, toggle whether each skill is required, and delete
          anything the source does not support. Approval is explicit; after approval objectives are frozen (a later change would be a new
          version with fresh evidence).
        </Notice>
      )}

      {data.topics.length === 0 && draft && <Card><p className="text-sm text-muted">No objectives yet. Add them manually below.</p></Card>}

      {data.topics.map((t) => (
        <Card key={t.id}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-serif text-xl font-semibold">{t.title}</h2>
            {!draft && <ButtonLink href={`/topics/${t.id}`} variant="secondary">Open topic</ButtonLink>}
          </div>
          <ol className="mt-4 space-y-4">
            {t.units.map((u) => {
              const e = edits[u.id];
              if (e?.delete) {
                return (
                  <li key={u.id} className="rounded-lg border border-dashed border-line p-3 text-sm text-muted">
                    &ldquo;{u.title}&rdquo; will be deleted when you save.{" "}
                    <button className="text-teal underline" onClick={() => editUnit(u.id, { delete: false })}>
                      Undo
                    </button>
                  </li>
                );
              }
              return (
                <li key={u.id} className="rounded-lg border border-line p-4" data-testid="unit">
                  {draft ? (
                    <div className="grid gap-2">
                      <label className="text-xs font-medium text-muted">
                        Unit title
                        <input
                          className="mt-1 w-full rounded-md border border-line px-2 py-1.5 text-sm text-ink"
                          value={e?.title ?? u.title}
                          onChange={(ev) => editUnit(u.id, { title: ev.target.value })}
                          data-testid="unit-title"
                        />
                      </label>
                      <label className="text-xs font-medium text-muted">
                        Objective
                        <input
                          className="mt-1 w-full rounded-md border border-line px-2 py-1.5 text-sm text-ink"
                          value={e?.objective ?? u.objective}
                          onChange={(ev) => editUnit(u.id, { objective: ev.target.value })}
                        />
                      </label>
                    </div>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-semibold">{u.title}</h3>
                        {u.version > 1 && <Pill>Version {u.version}</Pill>}
                      </div>
                      <p className="text-sm">{u.objective}</p>
                      {!data.course.isDemo && (
                        <button className="mt-1 text-xs text-teal underline" onClick={() => revise(u.id, u.objective)} disabled={busy}>
                          Revise objective (new version, fresh evidence)
                        </button>
                      )}
                    </>
                  )}
                  <p className="mt-2 text-xs text-muted">
                    Source:{" "}
                    {data.sources.map((s) =>
                      u.sourcePages.map((p) => (
                        <a
                          key={`${s.id}-${p}`}
                          className="mr-2 text-teal underline"
                          href={`/api/sources/${s.id}#page=${p}`}
                          target="_blank"
                          rel="noopener"
                          data-testid="source-page-link"
                        >
                          {s.label}, PDF page {p}
                        </a>
                      )),
                    )}
                  </p>
                  <ul className="mt-3 space-y-2">
                    {u.skills.map((s) => {
                      const se = e?.skills[s.id];
                      return (
                        <li key={s.id} className="flex flex-wrap items-center gap-3 text-sm">
                          <span className="text-xs text-muted">Skill</span>
                          {draft ? (
                            <>
                              <input
                                aria-label="Skill objective"
                                className="min-w-0 flex-1 rounded-md border border-line px-2 py-1 text-sm"
                                value={se?.objective ?? s.objective}
                                onChange={(ev) => editSkill(u.id, s.id, { objective: ev.target.value })}
                              />
                              <label className="flex items-center gap-1 text-xs">
                                <input
                                  type="checkbox"
                                  checked={se?.required ?? s.required}
                                  onChange={(ev) => editSkill(u.id, s.id, { required: ev.target.checked })}
                                  data-testid="skill-required"
                                />
                                Required
                              </label>
                            </>
                          ) : (
                            <>
                              <span className="flex-1">{s.objective}</span>
                              <Pill>{s.required ? "Required" : "Optional"}</Pill>
                              {!s.reviewAvailable && <Pill tone="warn">Reviewed assessment questions needed</Pill>}
                            </>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  {draft && (
                    <Button variant="danger" className="mt-3" onClick={() => editUnit(u.id, { delete: true })}>
                      Delete unsupported objective
                    </Button>
                  )}
                </li>
              );
            })}
          </ol>
        </Card>
      ))}

      {draft && (
        <Card>
          <h2 className="font-semibold">Add an objective manually</h2>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {(
              [
                ["topicTitle", "Topic"],
                ["title", "Unit title"],
                ["objective", "Objective (observable verb)"],
                ["pages", "Source PDF page(s), e.g. 1, 2"],
              ] as const
            ).map(([k, label]) => (
              <label key={k} className="text-xs font-medium text-muted">
                {label}
                <input
                  className="mt-1 w-full rounded-md border border-line px-2 py-1.5 text-sm text-ink"
                  value={adding[k]}
                  onChange={(ev) => setAdding((a) => ({ ...a, [k]: ev.target.value }))}
                />
              </label>
            ))}
          </div>
          <Button variant="secondary" className="mt-3" onClick={addObjective} disabled={busy}>
            Add objective
          </Button>
        </Card>
      )}

      {draft && (
        <div className="sticky bottom-4 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-card p-4 shadow-lg">
          <Button variant="secondary" onClick={() => save()} disabled={!dirty || busy} data-testid="save-draft">
            Save draft
          </Button>
          <Button onClick={approve} disabled={dirty || busy || data.topics.length === 0} data-testid="approve">
            Approve curriculum
          </Button>
          <span className="text-xs text-muted">{dirty ? "Save your edits before approving." : "Approval freezes these objectives."}</span>
        </div>
      )}

      {data.course.suggestions.length > 0 && (
        <Card>
          <h2 className="font-semibold">Suggested extensions (not required)</h2>
          <ul className="mt-2 list-disc pl-5 text-sm text-muted">
            {data.course.suggestions.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <h2 className="font-semibold">Sources</h2>
        <p className="mt-1 text-xs text-muted">
          Opening a PDF here records a source exposure for any active study session in this course, so answers given afterwards in that
          session count as supported.
        </p>
        {data.sources.map((s) => (
          <div key={s.id} className="mt-3 text-sm">
            <p>
              <a className="text-teal underline" href={`/api/sources/${s.id}`} target="_blank" rel="noopener">
                {s.label}
              </a>{" "}
              · {s.pageCount} pages · {s.status}
            </p>
            {s.pages.some((p) => p.lowTextWarning) && (
              <Notice tone="warn">
                Low extracted text on page(s) {s.pages.filter((p) => p.lowTextWarning).map((p) => p.page).join(", ")}. This heuristic does
                not prove other pages extracted correctly; check the text below.
              </Notice>
            )}
            {draft &&
              s.pages.map((p) => (
                <details key={p.page} className="mt-2 rounded-md border border-line p-2">
                  <summary className="text-xs">
                    PDF page {p.page} · {p.charCount} characters {p.lowTextWarning ? "· low-text warning" : ""}
                  </summary>
                  <pre className="mt-2 whitespace-pre-wrap font-sans text-xs text-muted">{p.text}</pre>
                </details>
              ))}
          </div>
        ))}
      </Card>
    </div>
  );
}
