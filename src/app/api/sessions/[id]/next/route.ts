import { ok, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { advanceLearning, getSessionView } from "@/lib/services/sessions";

export const runtime = "nodejs";

export const POST = route({ mutation: true }, async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const ctx = getAppContext();
  advanceLearning(ctx, id);
  return ok(getSessionView(ctx, id));
});
