import { z } from "zod";
import { ok, readJson, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { advanceActivity } from "@/lib/services/pacer";

export const runtime = "nodejs";

const bodySchema = z.strictObject({ action: z.enum(["continue", "skip"]) });

export const POST = route(
  { mutation: true },
  async (req: Request, { params }: { params: Promise<{ id: string; activityId: string }> }) => {
    const { id, activityId } = await params;
    const body = await readJson(req, bodySchema);
    return ok(advanceActivity(getAppContext(), id, activityId, body.action));
  },
);
