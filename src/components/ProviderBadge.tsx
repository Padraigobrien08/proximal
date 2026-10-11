"use client";

import { vendorName } from "@/lib/domain/labels";

export interface ProviderInfo {
  mode: "mock" | "live";
  vendor?: "anthropic" | "openai" | null;
  model: string | null;
  ready: boolean;
  message: string;
}

/** Prominent provider mode label. Mock mode is never presented as AI grading. */
export function ProviderBadge({ provider }: { provider: ProviderInfo }) {
  if (provider.mode === "mock") {
    return (
      <div data-testid="provider-badge" className="rounded-lg border border-amber-ink/25 bg-amber-soft px-4 py-2 text-sm text-amber-ink">
        <strong>Offline demo mode.</strong> Fixture answers only. Answers that are not the supplied demo examples are marked
        &ldquo;uncertain&rdquo;; nothing is graded by AI.
      </div>
    );
  }
  if (!provider.ready) {
    return (
      <div data-testid="provider-badge" role="alert" className="rounded-lg border border-red-ink/25 bg-red-soft px-4 py-2 text-sm text-red-ink">
        <strong>Live mode unavailable.</strong> {provider.message} Assessments will fail until this is fixed; there is no silent
        fallback to the offline demo.
      </div>
    );
  }
  return (
    <div data-testid="provider-badge" className="rounded-lg border border-teal/25 bg-teal-soft px-4 py-2 text-sm text-teal-dark">
      <strong>Live {vendorName(provider.vendor)} mode</strong> ({provider.model}). AI judgements are checked against the rubric server-side and can be flagged.
    </div>
  );
}
