import { ok, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { runForSession } from "@/lib/services/runs";
import { demoExamplesFor, getSessionView } from "@/lib/services/sessions";

export const runtime = "nodejs";

export const GET = route({ mutation: false }, async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const ctx = getAppContext();
  const view = getSessionView(ctx, id);
  const questionIds =
    view.session.status === "active"
      ? [view.current?.question.id, ...(Array.isArray(view.items) ? view.items.map((i) => ("question" in i ? i.question.id : undefined)) : [])]
      : [];
  const demoExamples = Object.fromEntries(
    [...new Set(questionIds.filter((x): x is string => !!x))].map((qid) => [qid, demoExamplesFor(ctx, qid)]),
  );
  return ok({ ...view, demoExamples, run: runForSession(ctx, id) });
});
