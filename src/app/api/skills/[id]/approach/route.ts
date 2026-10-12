import { z } from "zod";
import { ok, readJson, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { reviewClassification } from "@/lib/services/pacer";
import { PACER_TYPES } from "@/lib/pacer/taxonomy";

export const runtime = "nodejs";

const bodySchema = z.strictObject({
  action: z.enum(["accept", "edit", "dismiss"]),
  proposalId: z.string().min(1).nullable().optional(),
  primary: z.enum(PACER_TYPES).optional(),
  secondary: z.array(z.enum(PACER_TYPES)).max(2).optional(),
  reason: z.string().max(300).nullable().optional(),
  replacesDecisionId: z.string().min(1).nullable(),
});

/** Append a review decision (accept / edit / dismiss). Decisions affect new learning sessions only. */
export const POST = route({ mutation: true }, async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = await readJson(req, bodySchema);
  return ok(reviewClassification(getAppContext(), id, body), 201);
});
