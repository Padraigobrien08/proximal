import { z } from "zod";
import { ok, readJson, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { approveQuestionDraft, editQuestionDraft, rejectQuestionDraft, revealDraftAnswerKey } from "@/lib/services/questionDrafts";

export const runtime = "nodejs";

const bodySchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("edit"), question: z.unknown() }),
  z.strictObject({ action: z.literal("reveal_key") }),
  z.strictObject({ action: z.literal("approve"), use: z.enum(["checks", "practice"]) }),
  z.strictObject({ action: z.literal("reject") }),
]);

/** Owner review of one draft. Opening the key limits approval to practice; approve is the only path to a question. */
export const POST = route({ mutation: true }, async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = await readJson(req, bodySchema);
  const ctx = getAppContext();
  if (body.action === "edit") return ok(editQuestionDraft(ctx, id, body.question));
  if (body.action === "reveal_key") return ok(revealDraftAnswerKey(ctx, id));
  if (body.action === "approve") return ok(approveQuestionDraft(ctx, id, body.use));
  return ok(rejectQuestionDraft(ctx, id));
});
