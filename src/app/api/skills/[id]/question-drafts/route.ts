import { ok, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { generateQuestionDrafts } from "@/lib/services/questionDrafts";

export const runtime = "nodejs";

/** One explicit drafting request for a skill. Returns stored drafts; nothing is usable in a check until approved. */
export const POST = route({ mutation: true }, async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  return ok(await generateQuestionDrafts(getAppContext(), id), 201);
});
