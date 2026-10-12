import { z } from "zod";
import { ok, readJson, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { MAX_RESPONSE_CHARS, submitActivityResponse } from "@/lib/services/pacer";

export const runtime = "nodejs";

const bodySchema = z.strictObject({
  submissionKey: z.string().min(8).max(100),
  stepIndex: z.number().int().min(0).max(5),
  text: z.string().max(MAX_RESPONSE_CHARS + 100),
});

/** Save a learning response once per submission key. Never a pass, grade or schedule change. */
export const POST = route(
  { mutation: true },
  async (req: Request, { params }: { params: Promise<{ id: string; activityId: string }> }) => {
    const { id, activityId } = await params;
    const body = await readJson(req, bodySchema);
    const res = submitActivityResponse(getAppContext(), id, activityId, body);
    return ok(res, res.duplicate ? 200 : 201);
  },
);
