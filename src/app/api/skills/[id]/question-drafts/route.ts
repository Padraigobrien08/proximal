import { ok, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { requestQuestionDrafts } from "@/lib/services/questionDrafts";

export const runtime = "nodejs";

/** Queue one explicit drafting request for a skill (202). Drafts appear for review; none is usable until approved. */
export const POST = route({ mutation: true }, async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  return ok(requestQuestionDrafts(getAppContext(), id), 202);
});
