import { z } from "zod";
import { ok, readJson, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { endSession, getSessionView } from "@/lib/services/sessions";

export const runtime = "nodejs";

const bodySchema = z.strictObject({ scope: z.enum(["checkpoint", "session"]).default("session") });

export const POST = route({ mutation: true }, async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = await readJson(req, bodySchema);
  const ctx = getAppContext();
  endSession(ctx, id, body.scope);
  return ok(getSessionView(ctx, id));
});
