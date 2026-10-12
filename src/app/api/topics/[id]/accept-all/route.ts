import { z } from "zod";
import { ok, readJson, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { acceptAllDrafts } from "@/lib/services/pacer";

export const runtime = "nodejs";

/** Accept the displayed drafts only: the client lists the proposal ids it showed. */
const bodySchema = z.strictObject({ proposalIds: z.array(z.string().min(1)).min(1).max(20) });

export const POST = route({ mutation: true }, async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = await readJson(req, bodySchema);
  return ok(acceptAllDrafts(getAppContext(), id, body.proposalIds));
});
