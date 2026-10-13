import { ok, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { requestMaterialDraft } from "@/lib/services/materialDrafts";

export const runtime = "nodejs";

/** Queue drafting of activity material for one skill (202). Nothing is used until the owner approves it. */
export const POST = route({ mutation: true }, async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  return ok(requestMaterialDraft(getAppContext(), id), 202);
});
