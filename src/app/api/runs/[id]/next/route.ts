import { z } from "zod";
import { ok, readJson, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { advanceRun } from "@/lib/services/runs";

export const runtime = "nodejs";

const bodySchema = z.strictObject({ fromPosition: z.number().int().min(0) });

export const POST = route({ mutation: true }, async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = await readJson(req, bodySchema);
  return ok(advanceRun(getAppContext(), id, body.fromPosition));
});
