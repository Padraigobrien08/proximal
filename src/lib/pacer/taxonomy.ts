// PACER information-type taxonomy (adapted from Justin Sung's PACER; see docs/proximal/PACER_FEATURE_SPEC.md).
// Pure and client-safe. A PACER type describes content and its use for one objective; it is not a learner trait,
// an assessment level or a task type.

export const PACER_TAXONOMY_VERSION = "pacer-v1";
export const PACER_ROUTING_VERSION = "pacer-activities-v1";

export const PACER_TYPES = ["procedural", "analogous", "conceptual", "supporting_evidence", "reference"] as const;
export type PacerType = (typeof PACER_TYPES)[number];

export type ReviewStatus = "draft" | "accepted" | "edited" | "dismissed" | "stale";
export type MemoryRequirement = "unspecified" | "recall_required" | "lookup_allowed";
export const MEMORY_REQUIREMENTS: MemoryRequirement[] = ["unspecified", "recall_required", "lookup_allowed"];

export const ABSTAIN_REASONS = ["insufficient_context", "unclear_goal", "unreliable_extraction", "no_supported_fit"] as const;
export type AbstainReason = (typeof ABSTAIN_REASONS)[number];

/** UI label. "Supporting evidence" is never shortened to "Evidence": that word is reserved for the learner's record. */
export const PACER_LABEL: Record<PacerType, string> = {
  procedural: "Procedural",
  analogous: "Analogous",
  conceptual: "Conceptual",
  supporting_evidence: "Supporting evidence",
  reference: "Reference",
};

export const PACER_LETTER: Record<PacerType, string> = {
  procedural: "P",
  analogous: "A",
  conceptual: "C",
  supporting_evidence: "E",
  reference: "R",
};

/** Short working definitions for the help panel (not repeated on every card). */
export const PACER_DEFINITION: Record<PacerType, { definition: string; boundary: string }> = {
  procedural: {
    definition: "A method, operation or sequence you need to carry out.",
    boundary: "Naming the steps is not the same as carrying them out.",
  },
  analogous: {
    definition: "An explicit comparison in the material, or a connection to something you already know that you identify.",
    boundary: "Only used when the comparison actually exists; the app does not invent one.",
  },
  conceptual: {
    definition: "Principles, mechanisms, relationships, assumptions and reasons.",
    boundary: "A polished explanation alone does not show you can apply it.",
  },
  supporting_evidence: {
    definition: "A case, result or worked illustration that supports a conceptual claim.",
    boundary: "An illustration is not an experiment or a proof.",
  },
  reference: {
    definition: "Details kept as a usable reference, or recalled when the course requires it.",
    boundary: "Reference does not mean unimportant: required skills and their checks stay unchanged.",
  },
};

/** Words the rationale must use to explain each proposed type (lower-case stems). */
export const PACER_RATIONALE_STEM: Record<PacerType, string> = {
  procedural: "procedur",
  analogous: "analog",
  conceptual: "concept",
  supporting_evidence: "evidence",
  reference: "reference",
};

export const ABSTAIN_TEXT: Record<AbstainReason, string> = {
  insufficient_context: "More context needed.",
  unclear_goal: "The learning goal is unclear.",
  unreliable_extraction: "The source text could not be read reliably.",
  no_supported_fit: "No type is clearly supported by the material.",
};

export function isPacerType(x: unknown): x is PacerType {
  return typeof x === "string" && (PACER_TYPES as readonly string[]).includes(x);
}

/** "Mixed information: procedural and conceptual." for a mixed result, else null. */
export function mixedText(primary: PacerType, secondary: PacerType[]): string | null {
  if (secondary.length === 0) return null;
  const all = [primary, ...secondary].map((t) => PACER_LABEL[t].toLowerCase());
  const last = all.pop()!;
  return `Mixed information: ${all.join(", ")} and ${last}.`;
}
