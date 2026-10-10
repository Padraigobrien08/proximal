import { ok, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { getTopicView } from "@/lib/services/views";

export const runtime = "nodejs";

export const GET = route({ mutation: false }, async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  return ok(getTopicView(getAppContext(), id));
});
