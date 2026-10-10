import { ok, readJson, route } from "@/lib/http/handler";
import { getAppContext } from "@/lib/server";
import { draftPatchSchema, patchDraft } from "@/lib/services/imports";
import { getCourseView } from "@/lib/services/views";

export const runtime = "nodejs";

export const PATCH = route({ mutation: true }, async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const patch = await readJson(req, draftPatchSchema);
  const ctx = getAppContext();
  patchDraft(ctx, id, patch);
  return ok(getCourseView(ctx, id));
});
