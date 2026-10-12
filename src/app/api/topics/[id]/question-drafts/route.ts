import { ok, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { topicQuestionDrafts } from "@/lib/services/questionDrafts";

export const runtime = "nodejs";

/** Drafted questions awaiting review, and the approved questions, per skill of an imported topic. */
export const GET = route({ mutation: false, sensitiveRead: true }, async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  return ok(topicQuestionDrafts(getAppContext(), id));
});
