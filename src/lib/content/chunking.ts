// Splitting a long lecture into curriculum-drafting parts, and merging the parts' drafts. Pure.
// Parts are runs of whole consecutive pages: a page is never split, dropped or sent twice.
import type { CurriculumDraft } from "../llm/types";

/** Aim for parts of about this many characters (roughly 15k tokens), balanced across the document. */
export const CURRICULUM_PART_TARGET_CHARS = 60_000;
/** No single request is larger than this, even when balancing would prefer it. */
export const MAX_CURRICULUM_PART_CHARS = 80_000;
/** More parts than this is rejected rather than spending this many model calls on one import. */
export const MAX_CURRICULUM_PARTS = 8;

export interface PageText {
  page: number;
  text: string;
}

export interface CurriculumPart {
  index: number;
  total: number;
  pages: PageText[];
  firstPage: number;
  lastPage: number;
  chars: number;
}

export type PartPlan = { ok: true; parts: CurriculumPart[] } | { ok: false; reason: string };

/**
 * Balanced split: n = ceil(total / target) parts of about total / n characters each, closing a part before the page
 * that would push it past that (with 15% slack) or past the hard cap.
 */
export function planCurriculumParts(pages: PageText[], target = CURRICULUM_PART_TARGET_CHARS, hardMax = MAX_CURRICULUM_PART_CHARS): PartPlan {
  const oversized = pages.find((p) => p.text.length > hardMax);
  if (oversized) {
    return { ok: false, reason: `PDF page ${oversized.page} alone holds ${oversized.text.length.toLocaleString()} characters (limit ${hardMax.toLocaleString()} per request).` };
  }
  const total = pages.reduce((n, p) => n + p.text.length, 0);
  const wanted = Math.max(1, Math.ceil(total / target));
  const limit = Math.min(hardMax, Math.ceil((total / wanted) * 1.15));

  const groups: PageText[][] = [];
  let current: PageText[] = [];
  let chars = 0;
  for (const p of pages) {
    if (current.length > 0 && chars + p.text.length > limit) {
      groups.push(current);
      current = [];
      chars = 0;
    }
    current.push(p);
    chars += p.text.length;
  }
  if (current.length > 0) groups.push(current);

  if (groups.length > MAX_CURRICULUM_PARTS) {
    return {
      ok: false,
      reason: `Extracted text is ${total.toLocaleString()} characters, which would need ${groups.length} drafting requests (limit ${MAX_CURRICULUM_PARTS}). Upload a shorter excerpt; no pages are dropped silently.`,
    };
  }
  return {
    ok: true,
    parts: groups.map((g, i) => ({
      index: i + 1,
      total: groups.length,
      pages: g,
      firstPage: g[0].page,
      lastPage: g[g.length - 1].page,
      chars: g.reduce((n, p) => n + p.text.length, 0),
    })),
  };
}

const topicKey = (title: string) => title.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Merge part drafts in page order. A topic whose title repeats in a later part (it continued across the boundary)
 * gains that part's units instead of appearing twice. Suggestions are de-duplicated and capped as for one draft.
 */
export function mergeCurriculumDrafts(drafts: CurriculumDraft[]): CurriculumDraft {
  const topics: CurriculumDraft["topics"] = [];
  const byKey = new Map<string, CurriculumDraft["topics"][number]>();
  for (const d of drafts) {
    for (const t of d.topics) {
      const existing = byKey.get(topicKey(t.title));
      if (existing) existing.units.push(...t.units);
      else {
        const copy = { title: t.title, units: [...t.units] };
        byKey.set(topicKey(t.title), copy);
        topics.push(copy);
      }
    }
  }
  const seen = new Set<string>();
  const suggestions = drafts
    .flatMap((d) => d.suggestions)
    .filter((s) => {
      const k = s.trim().toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 10);
  return { topics, suggestions };
}
