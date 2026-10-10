"use client";

import { EVIDENCE_LABELS } from "@/lib/domain/labels";
import type { EvidenceState } from "@/lib/domain/types";

const ICON: Record<EvidenceState, string> = {
  unassessed: "○",
  developing: "◔",
  supported: "◑",
  demonstrated_once: "●",
  retention_demonstrated: "◉",
};

const TONE = {
  neutral: "bg-line/60 text-muted",
  info: "bg-sky-soft text-sky-ink",
  good: "bg-green-soft text-green-ink",
  warn: "bg-amber-soft text-amber-ink",
};

/** Text label (not colour alone) with an explanation on opening. */
export function EvidenceLabel({ state }: { state: EvidenceState }) {
  const l = EVIDENCE_LABELS[state];
  return (
    <details className="inline-block align-middle" data-testid={`evidence-${state}`}>
      <summary className={`inline-flex list-none items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE[l.tone]}`}>
        <span aria-hidden="true">{ICON[state]}</span>
        {l.label}
        <span className="sr-only">(show explanation)</span>
      </summary>
      <p className="mt-2 max-w-sm rounded-md border border-line bg-card p-2 text-xs text-muted">{l.explanation}</p>
    </details>
  );
}
