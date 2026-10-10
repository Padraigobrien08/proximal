"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { notifyDataChanged } from "./dataEvents";

/** Flag a judgement: optional short reason; excludes it from the learning record while keeping history. */
export function FlagJudgementButton({ assessmentId, onFlagged }: { assessmentId: string; onFlagged: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = ref.current;
    return () => {
      if (d?.open) d.close();
    };
  }, []);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/assessments/${assessmentId}/flag`, { method: "POST", json: { reason } });
      ref.current?.close();
      notifyDataChanged();
      onFlagged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not flag this judgement.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={() => ref.current?.showModal()}
        className="inline-flex min-h-9 items-center text-xs font-medium text-teal underline underline-offset-2"
      >
        Flag judgement
      </button>
      <dialog
        ref={ref}
        aria-labelledby={`flag-${assessmentId}`}
        onClose={() => trigger.current?.focus()}
        className="m-auto w-[min(480px,calc(100vw-2rem))] rounded-xl border border-line bg-card p-6 text-ink shadow-xl backdrop:bg-ink/40"
      >
        <h2 id={`flag-${assessmentId}`} className="text-[17px] font-semibold">
          Flag this judgement?
        </h2>
        <p className="mt-2 text-sm text-muted">
          This judgement is excluded from your learning record and your evidence and schedule are recalculated without it. The answer and
          the judgement stay visible in your history.
        </p>
        <label className="mt-4 block text-sm font-medium" htmlFor={`flag-reason-${assessmentId}`}>
          Reason (optional)
        </label>
        <textarea
          id={`flag-reason-${assessmentId}`}
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          className="mt-1 w-full rounded-lg border border-line-strong p-2 text-sm"
        />
        {error && (
          <p role="alert" className="mt-2 text-sm text-red-ink">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={() => ref.current?.close()} className="min-h-10 rounded-[7px] border border-line-strong px-3.5 text-sm">
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="min-h-10 rounded-[7px] bg-teal px-3.5 text-sm font-medium text-white hover:bg-teal-dark disabled:opacity-60"
          >
            {busy ? "Flagging…" : "Exclude judgement"}
          </button>
        </div>
      </dialog>
    </>
  );
}
