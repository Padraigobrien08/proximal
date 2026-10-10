import { z } from "zod";
import { ok, readJson, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { reveal } from "@/lib/services/sessions";

export const runtime = "nodejs";

const bodySchema = z.strictObject({
  kind: z.enum(["hint", "source", "solution", "explanation"]),
  sessionQuestionId: z.string().optional(),
  hintIndex: z.number().int().min(0).max(5).optional(),
  unitId: z.string().optional(),
  gapFromAttemptId: z.string().optional(),
});

export const POST = route({ mutation: true }, async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = await readJson(req, bodySchema);
  return ok(await reveal(getAppContext(), id, body));
});
