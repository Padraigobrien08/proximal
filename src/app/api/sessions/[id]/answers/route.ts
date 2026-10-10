import { z } from "zod";
import { ok, readJson, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { getSessionView, submitAnswer } from "@/lib/services/sessions";

export const runtime = "nodejs";

const bodySchema = z.strictObject({
  sessionQuestionId: z.string().min(1),
  submissionKey: z.string().min(8).max(100),
  answer: z.string().max(4000),
  dontKnow: z.boolean().optional(),
  confidence: z.enum(["low", "medium", "high"]).nullable().optional(),
  declaredAssistance: z.boolean().optional(),
});

export const POST = route({ mutation: true }, async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = await readJson(req, bodySchema);
  const ctx = getAppContext();
  const result = await submitAnswer(ctx, id, body);
  return ok({ result, session: getSessionView(ctx, id) }, result.duplicate ? 200 : 201);
});
