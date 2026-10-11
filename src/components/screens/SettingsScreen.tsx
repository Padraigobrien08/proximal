"use client";

import Link from "next/link";
import { useState } from "react";
import { api, ApiError } from "../api";
import { notifyDataChanged } from "../dataEvents";
import { useApiResource } from "../useApiResource";
import { Notice } from "../ui";

interface SettingsData {
  studyPlan: { modules: "all" | "chosen"; moduleIds: string[] };
  modules: { id: string; title: string; status: "draft" | "approved" }[];
}

export function SettingsScreen() {
  const { data, error, setData } = useApiResource<SettingsData>("/api/settings");
  // Local edits until saved; null means "as saved".
  const [draft, setDraft] = useState<SettingsData["studyPlan"] | null>(null);
  const [status, setStatus] = useState<{ tone: "good" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (error && !data) return <Notice tone="error">{error}</Notice>;
  if (!data) return <div aria-busy="true" className="h-[280px] max-w-[720px] rounded-xl border border-line bg-card" />;

  const plan = draft ?? data.studyPlan;
  const approved = data.modules.filter((m) => m.status === "approved");
  const chosen = new Set(plan.modules === "chosen" ? plan.moduleIds : approved.map((m) => m.id));
  const dirty = draft !== null;

  function update(next: SettingsData["studyPlan"]) {
    setDraft(next);
    setStatus(null);
  }

  function toggle(id: string, on: boolean) {
    const ids = new Set(chosen);
    if (on) ids.add(id);
    else ids.delete(id);
    update({ modules: "chosen", moduleIds: [...ids] });
  }

  async function save() {
    setBusy(true);
    try {
      setData(await api<SettingsData>("/api/settings", { method: "PUT", json: { studyPlan: plan } }));
      setDraft(null);
      setStatus({ tone: "good", text: "Saved. Continue on the overview now plans from these modules." });
      notifyDataChanged();
    } catch (err) {
      setStatus({ tone: "error", text: err instanceof ApiError ? err.message : "Could not save." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-[720px] space-y-6">
      <div>
        <h1 className="text-[28px] font-semibold leading-tight tracking-tight sm:text-[30px]">Settings</h1>
        <p className="mt-1 text-[15px] text-muted">Preferences for this local workspace.</p>
      </div>

      <section aria-labelledby="plan-title" className="rounded-xl border border-line bg-card p-5 sm:p-6">
        <h2 id="plan-title" className="text-[17px] font-semibold tracking-tight">
          Study plan
        </h2>
        <p className="mt-1 text-sm text-muted">
          Which modules Continue on the overview plans from. Study now on a single module always works, whatever you choose here.
        </p>

        <fieldset className="mt-4 space-y-2">
          <legend className="sr-only">Modules in your plan</legend>
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-line p-3 has-[:checked]:border-teal has-[:checked]:bg-teal-soft">
            <input
              type="radio"
              name="plan-modules"
              className="mt-1"
              checked={plan.modules === "all"}
              onChange={() => update({ modules: "all", moduleIds: [] })}
              data-testid="plan-all"
            />
            <span>
              <span className="block font-medium">All modules</span>
              <span className="block text-sm text-muted">One plan across everything you study. New modules join automatically once approved.</span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-line p-3 has-[:checked]:border-teal has-[:checked]:bg-teal-soft">
            <input
              type="radio"
              name="plan-modules"
              className="mt-1"
              checked={plan.modules === "chosen"}
              onChange={() => update({ modules: "chosen", moduleIds: [...chosen] })}
              data-testid="plan-chosen"
            />
            <span>
              <span className="block font-medium">Only the modules I choose</span>
              <span className="block text-sm text-muted">Focus on one module before an exam, or leave finished ones out.</span>
            </span>
          </label>
        </fieldset>

        {plan.modules === "chosen" && (
          <fieldset className="mt-4">
            <legend className="mb-2 text-sm font-medium">Include in Continue</legend>
            {approved.length === 0 ? (
              <p className="text-sm text-muted">No approved modules yet.</p>
            ) : (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {approved.map((m) => (
                  <li key={m.id}>
                    <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 text-sm">
                      <input type="checkbox" checked={chosen.has(m.id)} onChange={(e) => toggle(m.id, e.target.checked)} data-testid={`plan-module-${m.id}`} />
                      <span className="flex-1">{m.title}</span>
                      <Link href={`/courses/${m.id}`} className="text-xs text-teal hover:underline">
                        Open
                      </Link>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={!dirty || busy}
            data-testid="save-settings"
            className="inline-flex min-h-10 items-center rounded-[7px] bg-teal px-4 text-sm font-medium text-white hover:bg-teal-dark disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
          {dirty && (
            <button type="button" onClick={() => setDraft(null)} className="text-sm text-muted underline">
              Discard changes
            </button>
          )}
          <span role="status" className={`text-sm ${status?.tone === "error" ? "text-red-ink" : "text-teal-dark"}`}>
            {status?.text}
          </span>
        </div>
      </section>
    </div>
  );
}
