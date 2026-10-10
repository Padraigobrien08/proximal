import { z } from "zod";
import { ok, readJson, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { getSessionView, releaseCheckpointFeedback } from "@/lib/services/sessions";

export const runtime = "nodejs";

const bodySchema = z.strictObject({ withholdPending: z.boolean().optional() });

export const POST = route({ mutation: true }, async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = await readJson(req, bodySchema);
  const ctx = getAppContext();
  const res = releaseCheckpointFeedback(ctx, id, body);
  return ok({ ...res, session: getSessionView(ctx, id) });
});
