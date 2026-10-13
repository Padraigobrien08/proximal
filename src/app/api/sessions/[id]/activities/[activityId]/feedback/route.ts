import { z } from "zod";
import { ok, readJson, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { requestResponseFeedback } from "@/lib/services/pacer";

export const runtime = "nodejs";

const bodySchema = z.strictObject({ responseId: z.string().min(1).max(100) });

/** Tutor feedback on a saved learning response. Recorded as help first; never a grade or level change. */
export const POST = route(
  { mutation: true },
  async (req: Request, { params }: { params: Promise<{ id: string; activityId: string }> }) => {
    const { id, activityId } = await params;
    const body = await readJson(req, bodySchema);
    return ok(await requestResponseFeedback(getAppContext(), id, activityId, body.responseId));
  },
);
