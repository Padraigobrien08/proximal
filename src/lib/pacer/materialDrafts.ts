// AI-drafted learning-activity material for imported skills: wire contract, JSON schema, validation and conversion
// to authored-material shape. Pure. A draft is used only after the owner approves it; until then no activity uses it.
import { z } from "zod";
import type { ActivityMaterial } from "./registry";
import { normaliseWs } from "./validation";

export const MAX_MATERIAL_SOURCE_CHARS = 24_000;
const MAX_EXPLANATION = 2500;

const text = (max: number) => z.string().trim().min(1).max(max);

export const materialDraftSchema = z.strictObject({
  /** A teaching explanation for the unit; requested only when the unit has none. */
  explanation: z.strictObject({ text: text(MAX_EXPLANATION), workedExample: text(MAX_EXPLANATION).nullable() }).nullable(),
  connect: z.strictObject({ concepts: z.array(text(80)).min(2).max(5), prompt: text(600), hints: z.array(text(300)).max(2) }).nullable(),
  reconstruct: z.strictObject({ prompt: text(600) }).nullable(),
  createAnalogy: z.strictObject({ prompt: text(600) }).nullable(),
  evidence: z.strictObject({ page: z.number().int().positive(), excerpt: text(600), claim: text(300), prompt: text(600) }).nullable(),
  reference: z
    .strictObject({ page: z.number().int().positive(), excerpt: text(600), prompt: text(600), recallPrompt: text(400).nullable() })
    .nullable(),
});
export type MaterialDraft = z.infer<typeof materialDraftSchema>;

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });
const obj = (props: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(props), properties: props });
const str = { type: "string" };

export const materialDraftJsonSchema: Record<string, unknown> = obj({
  explanation: nullable(obj({ text: str, workedExample: nullable(str) })),
  connect: nullable(obj({ concepts: { type: "array", items: str }, prompt: str, hints: { type: "array", items: str } })),
  reconstruct: nullable(obj({ prompt: str })),
  createAnalogy: nullable(obj({ prompt: str })),
  evidence: nullable(obj({ page: { type: "integer" }, excerpt: str, claim: str, prompt: str })),
  reference: nullable(obj({ page: { type: "integer" }, excerpt: str, prompt: str, recallPrompt: nullable(str) })),
});

export type CheckedMaterial = { ok: true; draft: MaterialDraft } | { ok: false; draft: unknown; problems: string[] };

/**
 * Schema plus grounding: excerpts must be copied from the page they cite (whitespace-normalised), pages must be the
 * unit's own, Connect and Reconstruct come as a pair, and an explanation is only accepted when one was asked for.
 */
export function checkMaterialDraft(raw: unknown, pages: { page: number; text: string }[], opts: { explanationWanted: boolean }): CheckedMaterial {
  const parsed = materialDraftSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, draft: raw, problems: parsed.error.issues.map((i) => `${i.path.join(".") || "draft"}: ${i.message}`) };
  const d = parsed.data;
  const problems: string[] = [];
  const byPage = new Map(pages.map((p) => [p.page, normaliseWs(p.text)]));
  const grounded = (label: string, page: number, excerpt: string) => {
    const t = byPage.get(page);
    if (t === undefined) problems.push(`${label} cites page ${page}, which is not one of this subtopic's pages`);
    else if (!t.includes(normaliseWs(excerpt))) problems.push(`${label} excerpt is not copied word for word from page ${page}`);
  };
  if (d.evidence) grounded("evidence", d.evidence.page, d.evidence.excerpt);
  if (d.reference) grounded("reference", d.reference.page, d.reference.excerpt);
  if (!!d.connect !== !!d.reconstruct) problems.push("Connect and Reconstruct must be drafted together");
  if (d.explanation && !opts.explanationWanted) problems.push("an explanation was drafted although the subtopic already has one");
  if (opts.explanationWanted && d.connect && !d.explanation) problems.push("Connect and explain needs a teaching explanation for this subtopic");
  if (!d.connect && !d.createAnalogy && !d.evidence && !d.reference) problems.push("no activity material was drafted");
  return problems.length ? { ok: false, draft: d, problems } : { ok: true, draft: d };
}

/** Approved draft -> the authored-material shape activities read. Page excerpts use the course's page chunk ids. */
export function toActivityMaterial(d: MaterialDraft, chunkIdForPage: (page: number) => string): ActivityMaterial {
  return {
    ...(d.connect ? { connect: d.connect } : {}),
    ...(d.reconstruct ? { reconstruct: d.reconstruct } : {}),
    ...(d.createAnalogy ? { createAnalogy: d.createAnalogy } : {}),
    ...(d.evidence ? { evidence: { chunkId: chunkIdForPage(d.evidence.page), excerpt: d.evidence.excerpt, claim: d.evidence.claim, prompt: d.evidence.prompt } } : {}),
    ...(d.reference
      ? {
          reference: {
            chunkId: chunkIdForPage(d.reference.page),
            excerpt: d.reference.excerpt,
            page: d.reference.page,
            prompt: d.reference.prompt,
            recallPrompt: d.reference.recallPrompt,
          },
        }
      : {}),
  };
}
