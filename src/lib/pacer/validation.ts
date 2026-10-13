// Classification input/output contract and server-side grounding validation. Pure (no SDK or DB imports).
// Model output is a proposal, never a state change: the server stamps ids, hashes, versions and timestamps.
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ABSTAIN_REASONS,
  ABSTAIN_TEXT,
  MEMORY_REQUIREMENTS,
  PACER_LABEL,
  PACER_RATIONALE_STEM,
  PACER_TAXONOMY_VERSION,
  PACER_TYPES,
  type MemoryRequirement,
  type PacerType,
} from "./taxonomy";

// ---------------------------------------------------------------- limits (provisional engineering bounds)

export const MAX_OBJECTIVES_PER_REQUEST = 10;
export const MAX_SOURCE_CHARS_TOTAL = 12_000;
/** Raised from the spec's provisional 2,000: real imported units often cite several pages. */
export const MAX_CHARS_PER_OBJECTIVE = 4_000;
export const MAX_RATIONALE = 400;
export const MAX_AMBIGUITY = 300;
export const MAX_QUOTE = 240;
export const MAX_SUPPORT = 3;
export const MAX_SECONDARY = 2;

// ---------------------------------------------------------------- input

export type ChunkKind = "page" | "analogy" | "illustration" | "notation" | "excerpt";

export interface PacerChunk {
  chunkId: string;
  kind: ChunkKind;
  /** e.g. "Authored sample lecture, PDF page 4" or "Authored analogy". */
  label: string;
  page: number | null;
  /** Whitespace-normalised text. Untrusted data. */
  text: string;
}

export interface PacerObjectiveInput {
  objectiveId: string;
  objectiveVersion: number;
  objective: string;
  taskTypes: string[];
  /** Course purpose or explicit assessment requirement, only when actually supplied. */
  learningGoal: string | null;
  memoryRequirement: MemoryRequirement;
  /** Familiar connection supplied by the learner, never inferred. */
  learnerConnection: string | null;
  prerequisites: string[];
  chunks: PacerChunk[];
}

export const normaliseWs = (s: string) => s.replace(/\s+/g, " ").trim();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Identity of the classification context: objective version, full relevant chunks, supplied goal/familiarity context
 * and taxonomy version. A change makes earlier decisions stale for new sessions.
 */
export function contextHash(o: PacerObjectiveInput): string {
  return sha(
    JSON.stringify({
      taxonomy: PACER_TAXONOMY_VERSION,
      id: o.objectiveId,
      v: o.objectiveVersion,
      objective: normaliseWs(o.objective),
      taskTypes: [...o.taskTypes].sort(),
      goal: o.learningGoal ? normaliseWs(o.learningGoal) : null,
      memory: o.memoryRequirement,
      connection: o.learnerConnection ? normaliseWs(o.learnerConnection) : null,
      prerequisites: o.prerequisites,
      chunks: [...o.chunks]
        .sort((a, b) => a.chunkId.localeCompare(b.chunkId))
        .map((c) => ({ id: c.chunkId, kind: c.kind, text: normaliseWs(c.text) })),
    }),
  );
}

/** Cache identity: context + prompt version + provider/model. An unchanged request can reuse its saved proposal. */
export function cacheKey(context: string, promptVersion: string, providerIdentity: string): string {
  return sha(`${context}|${promptVersion}|${providerIdentity}`);
}

export function objectiveChars(o: PacerObjectiveInput): number {
  return o.objective.length + (o.learningGoal?.length ?? 0) + (o.learnerConnection?.length ?? 0) + o.chunks.reduce((n, c) => n + c.text.length, 0);
}

/**
 * Split objectives into bounded requests (count and total characters). Objectives that are too large on their own
 * are returned separately so they can be reported by name; nothing is truncated or silently dropped.
 */
export function planBatches(objectives: PacerObjectiveInput[]): { batches: PacerObjectiveInput[][]; tooLarge: PacerObjectiveInput[] } {
  const tooLarge = objectives.filter((o) => objectiveChars(o) > MAX_CHARS_PER_OBJECTIVE || o.chunks.length === 0);
  const batches: PacerObjectiveInput[][] = [];
  let cur: PacerObjectiveInput[] = [];
  let chars = 0;
  for (const o of objectives) {
    if (tooLarge.includes(o)) continue;
    const n = objectiveChars(o);
    if (cur.length > 0 && (cur.length >= MAX_OBJECTIVES_PER_REQUEST || chars + n > MAX_SOURCE_CHARS_TOTAL)) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(o);
    chars += n;
  }
  if (cur.length) batches.push(cur);
  return { batches, tooLarge };
}

export interface LimitProblem {
  objectiveId: string | null;
  message: string;
}

/** Over-limit input is rejected and disclosed; nothing is truncated or silently dropped. */
export function checkLimits(objectives: PacerObjectiveInput[]): LimitProblem[] {
  const problems: LimitProblem[] = [];
  if (objectives.length === 0) problems.push({ objectiveId: null, message: "Choose at least one objective." });
  if (objectives.length > MAX_OBJECTIVES_PER_REQUEST) {
    problems.push({
      objectiveId: null,
      message: `${objectives.length} objectives selected; at most ${MAX_OBJECTIVES_PER_REQUEST} per request. Choose a smaller selection.`,
    });
  }
  let total = 0;
  for (const o of objectives) {
    const n = objectiveChars(o);
    total += n;
    if (n > MAX_CHARS_PER_OBJECTIVE) {
      problems.push({ objectiveId: o.objectiveId, message: `"${o.objective}" has ${n} characters of context; the limit is ${MAX_CHARS_PER_OBJECTIVE}.` });
    }
    if (o.chunks.length === 0) problems.push({ objectiveId: o.objectiveId, message: `"${o.objective}" has no approved source text.` });
  }
  if (total > MAX_SOURCE_CHARS_TOTAL) {
    problems.push({ objectiveId: null, message: `${total} characters of context in total; the limit is ${MAX_SOURCE_CHARS_TOTAL}. Choose fewer objectives.` });
  }
  return problems;
}

// ---------------------------------------------------------------- output (domain shape)

const pacerType = z.enum(PACER_TYPES);

const supportSchema = z.discriminatedUnion("from", [
  z.strictObject({ from: z.literal("source"), chunkId: z.string().min(1).max(64), quote: z.string().min(1).max(MAX_QUOTE) }),
  z.strictObject({ from: z.literal("objective"), quote: z.string().min(1).max(MAX_QUOTE) }),
  z.strictObject({ from: z.literal("learner_context"), quote: z.string().min(1).max(MAX_QUOTE) }),
  z.strictObject({ from: z.literal("learning_goal"), quote: z.string().min(1).max(MAX_QUOTE) }),
]);

export const proposalSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("suggestion"),
    objectiveId: z.string().min(1).max(64),
    primary: pacerType,
    secondary: z.array(pacerType).max(MAX_SECONDARY),
    rationale: z.string().min(1).max(MAX_RATIONALE),
    support: z.array(supportSchema).min(1).max(MAX_SUPPORT),
    ambiguityNote: z.string().max(MAX_AMBIGUITY).nullable(),
  }),
  z.strictObject({
    kind: z.literal("abstain"),
    objectiveId: z.string().min(1).max(64),
    reason: z.enum(ABSTAIN_REASONS),
    message: z.string().min(1).max(MAX_AMBIGUITY),
  }),
]);

export type ClassificationProposal = z.infer<typeof proposalSchema>;
export type SupportItem = z.infer<typeof supportSchema>;
export type Suggestion = Extract<ClassificationProposal, { kind: "suggestion" }>;

// ---------------------------------------------------------------- output (model wire shape)

/**
 * Flat wire shape for strict structured output (every property required; nulls for the unused branch).
 * Converted into the discriminated union above before any check.
 */
export const wireResultSchema = z.strictObject({
  kind: z.enum(["suggestion", "abstain"]),
  objectiveId: z.string().max(64),
  primary: pacerType.nullable(),
  secondary: z.array(z.string().max(40)).max(5),
  rationale: z.string().max(2000).nullable(),
  support: z
    .array(
      z.strictObject({
        from: z.enum(["source", "objective", "learner_context", "learning_goal"]),
        chunkId: z.string().max(64).nullable(),
        quote: z.string().max(2000),
      }),
    )
    .max(6),
  ambiguityNote: z.string().max(2000).nullable(),
  abstainReason: z.enum(ABSTAIN_REASONS).nullable(),
  message: z.string().max(2000).nullable(),
});

export const wireBatchSchema = z.strictObject({ results: z.array(wireResultSchema).max(20) });
export type WireBatch = z.infer<typeof wireBatchSchema>;
export type WireResult = z.infer<typeof wireResultSchema>;

export const pacerJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "objectiveId", "primary", "secondary", "rationale", "support", "ambiguityNote", "abstainReason", "message"],
        properties: {
          kind: { type: "string", enum: ["suggestion", "abstain"] },
          objectiveId: { type: "string" },
          primary: { anyOf: [{ type: "string", enum: [...PACER_TYPES] }, { type: "null" }] },
          secondary: { type: "array", items: { type: "string", enum: [...PACER_TYPES] } },
          rationale: { anyOf: [{ type: "string" }, { type: "null" }] },
          support: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["from", "chunkId", "quote"],
              properties: {
                from: { type: "string", enum: ["source", "objective", "learner_context", "learning_goal"] },
                chunkId: { anyOf: [{ type: "string" }, { type: "null" }] },
                quote: { type: "string" },
              },
            },
          },
          ambiguityNote: { anyOf: [{ type: "string" }, { type: "null" }] },
          abstainReason: { anyOf: [{ type: "string", enum: [...ABSTAIN_REASONS] }, { type: "null" }] },
          message: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
      },
    },
  },
};

/** Wire result -> domain proposal candidate (not yet validated). */
export function fromWire(w: WireResult): unknown {
  if (w.kind === "abstain") {
    // The wire schema allows a null message; an abstention with a valid reason still stands, with that reason's text.
    const message = w.message?.trim() || (w.abstainReason ? ABSTAIN_TEXT[w.abstainReason] : w.message);
    return { kind: "abstain", objectiveId: w.objectiveId, reason: w.abstainReason, message };
  }
  return {
    kind: "suggestion",
    objectiveId: w.objectiveId,
    primary: w.primary,
    secondary: w.secondary,
    rationale: w.rationale,
    support: w.support.map((s) => (s.from === "source" ? { from: "source", chunkId: s.chunkId, quote: s.quote } : { from: s.from, quote: s.quote })),
    ambiguityNote: w.ambiguityNote,
  };
}

// ---------------------------------------------------------------- validation

export type ValidatedResult =
  | { objectiveId: string; ok: true; proposal: ClassificationProposal }
  | { objectiveId: string; ok: false; problems: string[] };

/** Semantic checks for one proposal against the objective input it claims to answer. */
export function validateProposal(o: PacerObjectiveInput, candidate: unknown): ValidatedResult {
  const parsed = proposalSchema.safeParse(candidate);
  if (!parsed.success) {
    return { objectiveId: o.objectiveId, ok: false, problems: parsed.error.issues.map((i) => `${i.path.join(".") || "result"}: ${i.message}`) };
  }
  const p = parsed.data;
  const problems: string[] = [];
  if (p.objectiveId !== o.objectiveId) problems.push(`result is for ${p.objectiveId}, expected ${o.objectiveId}`);
  if (p.kind === "abstain") {
    return problems.length ? { objectiveId: o.objectiveId, ok: false, problems } : { objectiveId: o.objectiveId, ok: true, proposal: p };
  }

  // Labels: unique, at most two secondary, none equal to the primary.
  if (new Set(p.secondary).size !== p.secondary.length) problems.push("duplicate secondary types");
  if (p.secondary.includes(p.primary)) problems.push("a secondary type repeats the primary type");
  const labels = [p.primary, ...p.secondary];

  // Each proposed type must be explained in the rationale (no unexplained label lists).
  const rationale = p.rationale.toLowerCase();
  for (const t of labels) {
    if (!rationale.includes(PACER_RATIONALE_STEM[t])) problems.push(`the rationale does not explain the ${PACER_LABEL[t].toLowerCase()} type`);
  }

  // Grounding: every quote must be an exact (whitespace-normalised) substring of what was actually supplied.
  const chunks = new Map(o.chunks.map((c) => [c.chunkId, c]));
  const quoteIn = (quote: string, text: string | null) => !!text && normaliseWs(text).includes(normaliseWs(quote)) && normaliseWs(quote).length > 0;
  for (const s of p.support) {
    if (s.from === "source") {
      const c = chunks.get(s.chunkId);
      if (!c) problems.push(`unknown chunk id ${s.chunkId}`);
      else if (!quoteIn(s.quote, c.text)) problems.push(`quote not found in chunk ${s.chunkId}`);
    } else if (s.from === "objective") {
      if (!quoteIn(s.quote, o.objective)) problems.push("quote not found in the objective");
    } else if (s.from === "learning_goal") {
      if (!o.learningGoal) problems.push("learning-goal support cited, but no learning goal was supplied");
      else if (!quoteIn(s.quote, o.learningGoal)) problems.push("quote not found in the learning goal");
    } else if (!o.learnerConnection) {
      problems.push("learner-context support cited, but no learner connection was supplied");
    } else if (!quoteIn(s.quote, o.learnerConnection)) {
      problems.push("quote not found in the learner connection");
    }
  }

  // Analogous needs an explicit comparison in the approved context or a learner-supplied connection.
  if (labels.includes("analogous")) {
    const grounded = p.support.some(
      (s) => s.from === "learner_context" || (s.from === "source" && chunks.get(s.chunkId)?.kind === "analogy"),
    );
    if (!grounded) problems.push("analogous needs support from an explicit approved comparison or a learner-supplied connection");
  }

  return problems.length ? { objectiveId: o.objectiveId, ok: false, problems } : { objectiveId: o.objectiveId, ok: true, proposal: p };
}

/**
 * Batch checks: exactly one result per requested objective; unknown and duplicate ids are errors and never become
 * suggestions. Returns one entry per requested objective, in request order, plus batch-level problems.
 */
export function validateBatch(objectives: PacerObjectiveInput[], candidates: unknown[]): { results: ValidatedResult[]; batchProblems: string[] } {
  const batchProblems: string[] = [];
  const byId = new Map<string, unknown[]>();
  const requested = new Set(objectives.map((o) => o.objectiveId));
  for (const c of candidates) {
    const id = typeof c === "object" && c && "objectiveId" in c ? String((c as { objectiveId: unknown }).objectiveId) : "";
    if (!requested.has(id)) {
      batchProblems.push(`result for unknown objective id "${id.slice(0, 64)}" ignored`);
      continue;
    }
    byId.set(id, [...(byId.get(id) ?? []), c]);
  }
  const results = objectives.map((o): ValidatedResult => {
    const got = byId.get(o.objectiveId) ?? [];
    if (got.length === 0) return { objectiveId: o.objectiveId, ok: false, problems: ["no result returned for this objective"] };
    if (got.length > 1) return { objectiveId: o.objectiveId, ok: false, problems: [`${got.length} results returned for this objective`] };
    return validateProposal(o, got[0]);
  });
  return { results, batchProblems };
}

/** Validate a learner/manual selection of types. */
export function validateSelection(primary: unknown, secondary: unknown): { primary: PacerType; secondary: PacerType[] } {
  const r = z
    .strictObject({ primary: pacerType, secondary: z.array(pacerType).max(MAX_SECONDARY) })
    .safeParse({ primary, secondary });
  if (!r.success) throw new Error(r.error.issues.map((i) => i.message).join("; "));
  if (new Set(r.data.secondary).size !== r.data.secondary.length) throw new Error("Choose each secondary type once.");
  if (r.data.secondary.includes(r.data.primary)) throw new Error("A secondary type cannot repeat the primary type.");
  return r.data;
}

export { MEMORY_REQUIREMENTS };
