import { z } from "zod";
import { ok, readJson, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { revealApproachDetails } from "@/lib/services/pacer";

export const runtime = "nodejs";

const bodySchema = z.strictObject({ skillIds: z.array(z.string().min(1)).max(20).optional() });

/** Rationales and support quotes. Exposure is committed in any active session with the skill before they are returned. */
export const POST = route({ mutation: true }, async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = await readJson(req, bodySchema);
  return ok(revealApproachDetails(getAppContext(), id, body.skillIds));
});
