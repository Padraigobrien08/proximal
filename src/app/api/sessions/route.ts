import { z } from "zod";
import { ok, readJson, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { startSession } from "@/lib/services/sessions";

export const runtime = "nodejs";

const bodySchema = z.strictObject({
  topicId: z.string().min(1),
  mode: z.enum(["learn", "review"]),
  skillIds: z.array(z.string()).max(3).optional(),
  size: z.number().int().min(1).max(3).optional(),
});

export const POST = route({ mutation: true }, async (req: Request) => {
  const body = await readJson(req, bodySchema);
  return ok(startSession(getAppContext(), body), 201);
});
