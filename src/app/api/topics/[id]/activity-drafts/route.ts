import { ok, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { topicMaterialDrafts } from "@/lib/services/materialDrafts";

export const runtime = "nodejs";

/** Prepared activities and pending activity drafts per skill of an imported topic. */
export const GET = route({ mutation: false, sensitiveRead: true }, async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  return ok(topicMaterialDrafts(getAppContext(), id));
});
